# Generated Image Preview and Placement Design

## Problem

Agent-generated images complete successfully but expose two inconsistent results:

- Chat receives a relative `/api/assets/:assetId` artifact URL, but that route is not implemented; the static Web client consequently renders an unresolvable source against its own origin.
- Image placement fields exist on `generate_image`, but the async job boundary drops them. The fallback policy is named `auto_right` but currently creates the element at `(0, 0)`.

The canvas can still display the image because its attachment pipeline embeds authorized asset data into the Excalidraw file. Chat preview and canvas attachment therefore have different failure modes.

## Goals

- Render generated image previews and downloads through the configured API origin.
- Preserve explicit placement coordinates and dimensions through asynchronous generation submission and attachment recovery.
- Place images predictably when coordinates are omitted, without overlapping existing content.
- Keep attachment retries idempotent and preserve the current authorization boundary.

## Non-Goals

- Redesigning the chat media card.
- Adding a general-purpose canvas layout engine.
- Changing image providers, generation quality, or storage visibility.
- Repositioning images that were already attached by historical runs.

## Considered Approaches

### 1. Recommended: preserve placement intent and resolve artifacts at the client boundary

Extend the async image submission contract with placement fields, persist them in the attachment intent, and compute final placement from the latest locked canvas state. Resolve opaque asset IDs through the existing authenticated upload URL endpoint before preview and download.

This fixes the broken contracts at their ownership boundaries and works for streaming, persisted messages, retries, and future API deployments.

### 2. Ask the Agent to move the image after generation

The prompt could instruct the Agent to call `manipulate_canvas` after attachment. This adds another model/tool round trip, races the background attachment, and does not fix chat previews or recovery.

### 3. Return public storage URLs directly

The worker could expose the storage URL in every artifact. This couples clients to storage topology, weakens the existing asset authorization boundary, and still leaves placement broken.

## Design

### Authorized artifact resolution

Generated artifacts carry their opaque `assetId`; they do not rely on the nonexistent `/api/assets/:assetId` route. The Web client resolves an asset through the existing authenticated `GET /api/uploads/:assetId/url` endpoint using the current access token. The endpoint verifies asset ownership and returns a browser-loadable URL.

Add one shared asynchronous resolver for `ImageArtifactCard`, detail previews, lightbox, and download. It exposes loading, ready, and failed states and never places an authenticated API URL directly in `<img src>`. It deduplicates only in-flight requests with a `userId + assetId` key and removes entries when requests settle. Authentication identity or token-generation changes increment an `authEpoch`, abort outstanding requests, and clear the in-flight map. Every completion checks its captured user ID and epoch before publishing a URL; stale completions are discarded even when the underlying request could not be canceled. The resolver does not maintain a long-lived resolved-URL cache, so expired signed URLs are not reused across mounts or sessions. Absolute HTTPS artifacts remain supported for existing messages. Invalid or failed resolutions render the existing failed-preview state and log only the asset ID and bounded error code.

The artifact contract becomes an explicit union: new artifacts require `assetId` and may omit `url`; legacy artifacts without `assetId` require an absolute HTTPS `url`. Both branches retain the media metadata. The persisted-message compatibility decoder strictly matches legacy relative URLs against `^/api/assets/([0-9a-fA-F-]{36})$`, validates the capture as a UUID, and converts it to the new `assetId` branch so historical previews use the authenticated resolver. Other relative URLs become a failed-preview state and are never issued as browser requests. New runtime events emit `assetId` and no relative URL. This guarantees every renderable artifact has exactly one authorized resolution path.

### Placement contract

Replace the flat placement fields in the image tool input and `SubmitImageJobFn` with one optional nested discriminated union named `placement`. Omitting the object means automatic placement. Forward the parsed object unchanged from `runImageGenerate` into the runtime submission closure. `createAgentAttachmentContext` persists one of:

- `{ kind: "explicit", x, y, width, height }`; or
- `{ kind: "relative", elementId, relation, gap, maxWidth?, maxHeight? }`, where relation is one of `above`, `below`, `left`, or `right` and gap defaults to 48; or
- `{ kind: "auto_right" }` when `placement` is omitted or explicitly automatic.

The discriminator makes placement modes mutually exclusive in both the model-visible JSON schema and runtime validation. Explicit coordinates must be finite and dimensions positive. Relative element IDs are bounded strings, maximum dimensions are positive when supplied, and gaps outside `0..400` fail tool argument validation. Invalid input never silently degrades to automatic placement. Removing defaults from the old flat width and height fields prevents omitted placement from materializing as a partial explicit request.

The new `relative` variant is added consistently to `AgentAttachmentPlacement`, the submit-generation Zod schema, the attachment repository schema, and their shared types. A database migration first replaces `generated_asset_attachment_placement_shape` with a constraint that accepts the exact `auto_right`, `explicit`, and `relative` JSON shapes, then replaces `fulfill_generated_asset_attachment`. The migration preserves existing rows and grants; existing placement JSON remains valid.

The main Agent prompt and the `generate_image` tool description require this sequence whenever the user names a spatial relation to existing content: call `inspect_canvas`, select the target element ID, then call `generate_image` with `placement: { kind: "relative", elementId, relation }`. The Agent must not substitute `auto_right` for an explicit relational request.

### Automatic placement

Placement is finalized inside a new migration of `fulfill_generated_asset_attachment`, after the function has locked the latest canvas row. No application-layer read is used for final coordinates.

- `explicit` uses the validated stored coordinates and exact display dimensions. Explicit placement permits intentional non-proportional display sizing.
- `relative` finds the latest live target element by ID and positions the generated element on the requested side with the stored gap. For `above` and `below`, centers align horizontally; for `left` and `right`, centers align vertically.
- `auto_right` computes the maximum right edge of live elements, adds a fixed gap, and vertically aligns with the rightmost live element. Deleted elements are ignored.
- An empty canvas centers the generated element around the canvas origin.

For `relative` and `auto_right`, attachment preparation derives display dimensions from the completed job's actual width and height. It scales proportionally into the requested maximum bounds or the existing media maximum and sends those resolved dimensions to the transaction. If a relative target was deleted before fulfillment, the transaction falls back to `auto_right`. The transaction stores the requested placement kind, final placement rectangle, and bounded fallback reason in the idempotent attachment receipt. This keeps the generated asset available without attaching over unrelated content and makes replay return the original placement decision.

### Observability and errors

Extend the strict attachment receipt schema with `requestedPlacementKind`, final `placement`, and nullable `fallbackReason`. `fulfill_generated_asset_attachment` writes these fields to the persisted job-effect receipt and returns them on first execution and replay. The reconciler logs from that receipt after fulfillment. Logs include asset or job ID, canvas ID, requested placement kind, fallback reason, and bounded coordinates, but no resolved URLs, prompts, or access tokens. Authorized artifact resolution failures follow the same bounded logging rule.

Existing attachment recovery behavior remains unchanged: generation success and attachment completion stay separate states.

## Testing

- Shared-contract tests prove new artifacts require `assetId`, legacy artifacts require absolute HTTPS URLs, source-less artifacts are rejected, valid historical `/api/assets/:uuid` URLs recover their asset ID, and malformed relative URLs never reach the browser.
- Web unit tests prove asset IDs resolve through the authenticated upload URL endpoint, in-flight resolution is deduplicated only within one user, authentication changes abort requests and suppress stale completions by epoch, absolute HTTPS legacy artifacts remain usable, and invalid relative legacy URLs are not loaded from the Web origin.
- Runtime tests prove explicit and relative placement fields cross the async submission boundary and produce the matching attachment intent. A full Agent behavior test proves a relational request produces `inspect_canvas` followed by `generate_image` with the target ID and relation.
- Tool schema tests prove omitted placement becomes `auto_right`, each nested variant produces its matching intent, and invalid coordinates, element IDs, dimensions, and gaps are rejected.
- Database migration tests prove old placement rows remain valid and all three new JSON shapes satisfy the replacement constraint. Database integration tests prove explicit coordinates are preserved; `below` uses the latest target bounds; a deleted target falls back safely; automatic placement is right of existing live content; deleted elements are ignored; empty canvases center around the origin; and first execution and replay return identical placement metadata.
- Dimension tests prove relative and automatic placement preserve the completed image aspect ratio within maximum bounds, while explicit dimensions remain exact.
- Existing attachment recovery, tool governance, chat rendering, type checks, and builds remain green.
- A browser smoke test verifies the thumbnail loads and a `below` relation places the generated image beneath the target text without overlap.

## Success Criteria

- The chat thumbnail and download resolve the asset through an authenticated endpoint and use the returned browser-reachable URL.
- A request to place an image below a known text element persists a relative placement intent and results in `y >= text.y + text.height + gap` using the target's latest bounds.
- Missing placement no longer stacks generated media over existing elements at `(0, 0)`.
- Retrying attachment does not create duplicate elements.
