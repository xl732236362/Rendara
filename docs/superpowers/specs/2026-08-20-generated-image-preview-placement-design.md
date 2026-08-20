# Generated Image Preview and Placement Design

## Problem

Agent-generated images currently fail in two independent places:

- Chat receives `/api/assets/:assetId`, but that route does not exist. The static Web client resolves the relative URL against its own origin, so preview and download fail.
- `generate_image` accepts placement fields, but the asynchronous submission boundary does not persist them. The attachment worker therefore loses requests such as "place the image below this text", and `auto_right` currently falls back to `(0, 0)`.

The successful generated-media artifact is also not projected from the LangChain `ToolMessage.artifact` into the canonical `tool.completed` event. Even with a valid asset, the persisted assistant tool block can consequently contain no image artifact.

## Goals

- Resolve generated image previews and downloads through the authenticated API origin.
- Carry image placement intent through job submission and attachment fulfillment.
- Place a generated image below, above, left, or right of the latest version of a referenced canvas element.
- Make automatic placement avoid the current `(0, 0)` stacking behavior.
- Keep submission, attachment, and assistant-message persistence idempotent enough for normal retries and reconnects.

## Non-Goals

- Redesigning the chat media card.
- Building a general canvas layout or collision-resolution engine.
- Repairing arbitrary malformed historical database rows.
- Introducing placement-policy or attachment-receipt version frameworks.
- Reconstructing missing Agent effects or redesigning Agent attempt recovery.
- Changing video placement, providers, storage visibility, or already attached elements.

## Design

### Image artifact contract

The normalized image artifact source is one of:

- `{ kind: "asset", assetId }` for a generated or uploaded private asset; or
- `{ kind: "external", url }` for an absolute HTTPS URL already present in historical data.

The shared wire decoder accepts the normalized source, a transition `assetId`, or the current `url`. A valid historical `/api/assets/:uuid` URL is converted to an asset source. A valid absolute HTTPS URL is converted to an external source. Conflicting identities or an invalid source invalidate only that artifact: the decoder drops the artifact, emits a bounded diagnostic containing no URL, and continues decoding the containing message or stream event. Required media metadata remains bounded and validated. Video artifacts keep their current schema and bypass this image normalizer.

Server persistence stores normalized artifacts. During the static-client compatibility window, the transport serializer emits the normalized source and the current `url` field: asset sources use `/api/assets/:assetId`, while external sources reuse their HTTPS URL. The new Web client uses the normalized source; old clients ignore the additional field and retain their existing behavior. No sentinel asset ID or multi-code unavailable protocol is introduced.

Normalization runs at the shared boundaries used by persisted `tool_activities[*].artifacts`, tool-type `content_blocks[*].artifacts`, `tool.completed`, and `tool.failed`. It does not process the unrelated top-level user-upload image content block. `useWebSocket` decodes the shared WebSocket envelope instead of asserting its type.

### Authorized preview resolution

An `ArtifactResolutionProvider` is mounted inside the root `AuthProvider`, because `/canvas` is not owned by the workspace route-group layout. For an asset source it calls the existing authenticated `GET /api/uploads/:assetId/url` endpoint with the current access token. The endpoint continues to authorize through the existing workspace-membership RLS policy.

`AuthProvider` exposes the verified session user ID, access token, and an `authGeneration` updated atomically whenever either identity or token changes. Resolution requests are keyed by `viewerId + authGeneration + assetId`, deduplicated while in flight, and aborted and cleared when authentication changes. A result is rendered only when its captured viewer and generation still match the current session, preventing a signed URL from one account appearing after logout, token refresh, or account switch.

The resolver does not keep a long-lived signed-URL cache. A thumbnail resolves on mount and may resolve once more after an image-load failure. Download always resolves at click time. Resolution failures render the existing failed-preview state and log only the asset ID and a bounded error code. External HTTPS sources continue to render directly.

### Tool lifecycle and message persistence

Runtime completion and attachment recovery use one generated-media result decoder. For images it requires a UUID asset ID, positive integer dimensions, and an `image/*` MIME type. Before publishing the artifact, the runtime verifies the asset row under the current user scope and checks its generation job, workspace, project, and MIME type. The attachment worker performs the equivalent check through its admin repository. Invalid results become the bounded `generated_media_result_invalid` or `attachment_integrity_failure` error already appropriate to that boundary.

After a successful tool call, `LoomicToolGovernance.wrapToolCall` inspects only generated-media `ToolMessage.artifact` values carrying the `attachmentStatus` discriminator. It parses the complete value with `generatedMediaToolResultSchema`. `attached` and `not_requested` results pass their single validated artifact to `stageCompleted`; `pending` and `not_attached` retain the existing generated-asset failure path. Arbitrary LangChain artifacts and legacy direct-provider payloads without that discriminator are not exposed to clients.

The WebSocket handler terminally upserts both `tool.completed` and `tool.failed` into its assistant-block accumulator by `toolCallId`. Completed blocks receive validated artifacts and output summary; failed blocks receive the public error, recovery action, and any validated artifact. A terminal event without a matching started block creates a bounded terminal tool block so reconnect replay cannot drop the result.

The server is the authoritative writer of assistant messages. The new Web client stops calling `saveMessage` for the assistant placeholder after a terminal run event; it continues to save user messages. Cached old clients may still create a second assistant row during the compatibility window, so `listMessages` retains transitional deduplication for adjacent rows with the same role and text but no longer keeps the first row blindly. It retains the candidate with more terminal tool blocks, then more artifacts, then more content blocks; exact ties retain the earlier row. This prevents an incomplete client copy from hiding the server copy that contains the generated artifact. Historical cleanup and removal of this compatibility rule are separate from this fix.

### Placement input and persistence

Replace the image tool's flat placement fields with one optional discriminated union:

- `{ kind: "explicit", x, y, width, height }`;
- `{ kind: "relative", elementId, relation, gap?, maxWidth?, maxHeight? }`, where relation is `above`, `below`, `left`, or `right`; or
- `{ kind: "auto_right" }`, also used when placement is omitted.

Coordinates must be finite and within `+/-1,000,000`; explicit dimensions are `1..16,384`; relative maximum dimensions are `1..4,096`; `gap` defaults to 48 and is limited to `0..400`; and element IDs are non-empty and at most 256 characters. The model-visible schema, application schema, and new relative database CHECK branch enforce the same limits. Invalid input does not degrade to automatic placement.

`runImageGenerate` forwards the parsed placement unchanged through `SubmitImageJobFn` into the attachment intent. Image attachment context accepts all three modes. Video attachment context remains limited to its current `auto_right` and `explicit` modes. The direct image provider preserves explicit placement but rejects relative placement before invoking the provider, using `relative_placement_requires_attachment_backend`. That typed error is raised outside the legacy direct-provider catch, or explicitly rethrown by it, so governance receives the failure instead of a successful payload containing an `error` field.

The migration expands the existing placement CHECK without adding a version column. Its historical `auto_right` and positive explicit branches remain valid so existing rows are not tightened retroactively. It adds the bounded relative branch only for `media_type = 'image'`. New explicit inputs receive their tighter limits from the application and submission function.

### Submission and attachment execution

The attachment overload of `submit_generation_job` preserves idempotent replay before mutable authorization checks. After the base submission returns the durable job ID, it loads an existing `(job_id, effect_kind)` intent first. A complete immutable match across intent ID, user/workspace/project/canvas/session, run/attempt/fence, logical tool call, input digest, media type, and placement is returned even if the old attempt lease expired, the effect completed, or the relative target was later deleted. A mismatch is `idempotency_conflict`. First creation uses `insert ... on conflict do nothing returning`; a concurrent loser reloads the winner and applies the same complete comparison before returning it.

Only first creation requires the active run, current attempt fence, and matching reserved Agent effect. A new relative intent validates in the same transaction that the canvas contains exactly one live element with the requested ID. Missing, deleted, or duplicate live targets return `relative_target_not_found` and roll back the job submission and intent. Matching replays do not repeat this mutable target check. The function rejects canvases with more than 10,000 element entries before JSON expansion using `placement_canvas_too_complex`.

Attachment fulfillment locks the latest canvas row before calculating coordinates. It repeats the 10,000-entry check before expanding the latest elements array, because the canvas may have grown after submission. An entry is live unless `isDeleted` is `true`; deleted entries are ignored after the count check. Every live entry used for target or automatic placement must have a non-empty ID bounded to 256 characters, and its numeric geometry is validated before casting. Existing element coordinates, dimensions, derived bounds, and final coordinates must be finite and stay within a global absolute bound of 10,000,000; invalid canvas geometry settles as `attachment_integrity_failure` without modifying the canvas.

For a live element with top-left `(x, y)`, non-negative size `(w, h)`, and finite angle `a` in radians, visual axis-aligned bounds are calculated around its center with:

- `hx = (abs(cos(a)) * w + abs(sin(a)) * h) / 2 + padding`
- `hy = (abs(sin(a)) * w + abs(cos(a)) * h) / 2 + padding`

`padding` is at least one canvas unit and includes half of a valid non-negative stroke width when present. A missing angle defaults to zero. A present angle must be finite and within `+/-2*pi()`, and a present stroke width must be non-negative, finite, and within the global geometry bound; otherwise fulfillment fails integrity validation before trigonometry. These bounds are used for the referenced target and for one maximum-right aggregation used by automatic placement. The design does not perform collision resolution against unrelated elements.

The completed image's display size preserves aspect ratio and never upscales. `auto_right` fits within 600 by 600. `relative` uses each supplied maximum and 600 for an omitted maximum. `explicit` uses the stored exact dimensions and may intentionally change aspect ratio.

Final coordinates are deterministic:

- `below`: `(targetCenterX - width / 2, targetVisualBottom + gap)`
- `above`: `(targetCenterX - width / 2, targetVisualTop - gap - height)`
- `right`: `(targetVisualRight + gap, targetCenterY - height / 2)`
- `left`: `(targetVisualLeft - gap - width, targetCenterY - height / 2)`
- `auto_right`: place the image 80 units after the maximum visual right edge and vertically center it on the rightmost element selected by visual right descending, visual top ascending, then element ID ascending
- empty canvas: center the image at the origin

Fulfillment again requires at most one live element with the relative target ID. If the target was deleted or removed after submission, it uses the `auto_right` coordinates while preserving the size prepared from the relative maxima. More than one live match is an integrity failure. No other relative-placement failure silently changes modes.

The existing deterministic element ID derived from the job ID remains the attachment idempotency key. Canvas content, revision, attachment receipt, intent state, outbox event, and matching reserved Agent effect are committed in the same transaction. A matching reserved effect may be completed after its original attempt lease expires because the committed attachment intent already carries the immutable attempt, fence, logical-call, and digest identity. Receipt replay applies the same promotion to a matching reserved effect. A missing or mismatched effect is an integrity failure; this design does not reconstruct it. An already completed full tool result is not overwritten.

When runtime recovery reads a completed generated-media Agent effect, it first normalizes and parses a stored full tool result. If the stored value is instead the existing attachment receipt without an artifact, it loads the terminal job through the same generated-media decoder and asset-scope check, then combines the canonical artifact with the current public attachment status. A historical pending or not-attached result is also refreshed; if it has become attached and lacks an artifact, the runtime hydrates the artifact before constructing the strict attached result. Hydration failure returns `generated_media_effect_invalid`. This uses the current receipt shape and does not add receipt versions or reconstruct missing effects.

Typed placement errors are converted by the governance middleware into status-error `ToolMessage` values and canonical `tool.failed` events with bounded public codes. Deterministic placement errors do not consume all attachment retry attempts. Logs include bounded job, asset, canvas, placement-kind, fallback, and finite coordinate fields, but never prompts, access tokens, or resolved URLs.

## Deployment

Use three compatible phases:

1. Deploy consumers first: shared image normalization, authenticated Web resolution, successful-artifact lifecycle projection, authoritative server assistant persistence with transitional duplicate selection, and a worker that understands relative placement. Generated image transport still includes the current `url` field, and placement producers remain unchanged.
2. Apply the transactional database migration that expands the existing placement CHECK and replaces only the attachment overload of `submit_generation_job` and `fulfill_generated_asset_attachment` without changing their signatures, security-definer settings, grants, or public attachment-status shape. Then enable nested image placement in the server producer.
3. After the supported static-client lifetime, stop emitting the legacy image `url`. Keep the historical relative-URL reader because persisted messages outlive deployments.

Rollback after phase 2 targets the phase-1 consumer build, which understands relative intents even though it does not produce them. Do not roll the worker or server back to a version that cannot read relative placement while such intents remain. No rollback deletes generated assets, attachment intents, or canvas elements.

## Testing

- Shared contract tests cover canonical asset and external sources, transition `assetId`, historical `/api/assets/:uuid`, malformed artifact isolation, and unchanged video fixtures.
- Web tests cover authenticated resolution, in-flight deduplication, synchronous suppression on authentication changes, stale completion rejection, one image refresh, and fresh download resolution.
- Governance tests prove a successful generated-media result publishes exactly one validated artifact and typed media failures preserve their bounded codes.
- WebSocket persistence tests cover completed and failed terminal upserts, terminal-without-started recovery, authoritative server persistence, and compatibility deduplication preferring the artifact-complete assistant copy.
- Tool tests cover omitted, explicit, and relative image placement; video rejection of relative placement; direct-provider rejection before provider invocation; and all input bounds.
- Database tests cover matching replay after lease expiry or target deletion, first-use target validation, rollback on validation failure, the 10,000-element limit, explicit coordinates, all four relative formulas, rotation-aware target bounds, deleted-target fallback, automatic and empty-canvas placement, aspect-ratio sizing, deterministic element IDs, and atomic canvas/receipt/effect completion.
- Agent recovery tests cover a stored full tool result, the existing receipt-only effect, and a pending result that becomes attached without a stored artifact.
- Existing attachment recovery, chat rendering, type checks, and builds remain green.
- A browser smoke test verifies that a generated thumbnail loads and a `below` request places the image beneath the referenced text element.

## Success Criteria

- Chat preview and download resolve a generated asset through the authenticated upload URL endpoint.
- Streaming and reloaded assistant messages contain the same generated image artifact.
- A `below` request persists the target ID and produces `imageVisualTop >= targetVisualBottom + gap` from the target's latest canvas state.
- Omitted placement no longer stacks generated media at `(0, 0)`.
- Retrying submission or attachment does not create a duplicate canvas element.
