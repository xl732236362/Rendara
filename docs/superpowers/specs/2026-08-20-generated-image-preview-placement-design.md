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

Extend the async image submission contract with placement fields, persist them in the attachment intent, and compute a real fallback placement from the current canvas bounds. Resolve API-relative artifact URLs with the existing Web environment helper before preview and download.

This fixes the broken contracts at their ownership boundaries and works for streaming, persisted messages, retries, and future API deployments.

### 2. Ask the Agent to move the image after generation

The prompt could instruct the Agent to call `manipulate_canvas` after attachment. This adds another model/tool round trip, races the background attachment, and does not fix chat previews or recovery.

### 3. Return public storage URLs directly

The worker could expose the storage URL in every artifact. This couples clients to storage topology, weakens the existing asset authorization boundary, and still leaves placement broken.

## Design

### Authorized artifact resolution

Generated artifacts carry their opaque `assetId`; they do not rely on the nonexistent `/api/assets/:assetId` route. The Web client resolves an asset through the existing authenticated `GET /api/uploads/:assetId/url` endpoint using the current access token. The endpoint verifies asset ownership and returns a browser-loadable URL.

Add one shared asynchronous resolver for `ImageArtifactCard`, detail previews, lightbox, and download. It exposes loading, ready, and failed states, deduplicates concurrent requests for the same asset, and never places an authenticated API URL directly in `<img src>`. Absolute HTTPS artifacts remain supported for existing messages. Invalid or failed resolutions render the existing failed-preview state and log only the asset ID and bounded error code.

The artifact contract gains `assetId` as the canonical identity. The legacy relative `url` field remains readable during migration but is not used as a browser source. Persisted historical artifacts without `assetId` may use an existing absolute HTTPS URL; an unresolved relative legacy URL renders the failure state instead of issuing a request to the Web origin.

### Placement contract

Add optional `placementX`, `placementY`, `placementWidth`, `placementHeight`, `placementReferenceElementId`, `placementRelation`, and `placementGap` fields to `SubmitImageJobFn`. Forward them from `runImageGenerate` into the runtime submission closure. `createAgentAttachmentContext` then persists one of:

- `explicit`, when both coordinates are supplied, with dimensions; or
- `relative`, when a reference element and one of `above`, `below`, `left`, or `right` are supplied, with dimensions and a bounded gap; or
- `auto_right`, when neither explicit nor relative placement is supplied.

Placement input is an exclusive union. Partial coordinate pairs, incomplete relative placement, non-finite coordinates, non-positive dimensions, and non-positive or excessive gaps fail tool argument validation so the Agent can correct them. They never silently degrade to automatic placement.

### Automatic placement

Placement is finalized inside a new migration of `fulfill_generated_asset_attachment`, after the function has locked the latest canvas row. No application-layer read is used for final coordinates.

- `explicit` uses the validated stored coordinates.
- `relative` finds the latest live target element by ID and positions the generated element on the requested side with the stored gap. For `above` and `below`, centers align horizontally; for `left` and `right`, centers align vertically.
- `auto_right` computes the maximum right edge of live elements, adds a fixed gap, and vertically aligns with the rightmost live element. Deleted elements are ignored.
- An empty canvas centers the generated element around the canvas origin.

If a relative target was deleted before fulfillment, the transaction falls back to `auto_right` and records a bounded warning. This keeps the generated asset available without attaching over unrelated content. Generated dimensions retain aspect ratio and remain capped by the existing media maximum.

### Observability and errors

Add structured logs for authorized artifact resolution failures and attachment placement decisions. Logs include asset or job ID, canvas ID, placement kind, relation, fallback reason, and bounded coordinates, but no resolved URLs, prompts, or access tokens.

Existing attachment recovery behavior remains unchanged: generation success and attachment completion stay separate states.

## Testing

- Web unit tests prove asset IDs resolve through the authenticated upload URL endpoint, concurrent resolution is deduplicated, absolute HTTPS legacy artifacts remain usable, and relative legacy URLs are not loaded from the Web origin.
- Runtime tests prove explicit and relative placement fields cross the async submission boundary and produce the matching attachment intent.
- Tool schema tests reject partial coordinates, incomplete relations, invalid dimensions, and invalid gaps.
- Database integration tests prove explicit coordinates are preserved; `below` uses the latest target bounds; a deleted target falls back safely; automatic placement is right of existing live content; deleted elements are ignored; and empty canvases center around the origin.
- Existing attachment recovery, tool governance, chat rendering, type checks, and builds remain green.
- A browser smoke test verifies the thumbnail loads and a `below` relation places the generated image beneath the target text without overlap.

## Success Criteria

- The chat thumbnail and download resolve the asset through an authenticated endpoint and use the returned browser-reachable URL.
- A request to place an image below a known text element persists a relative placement intent and results in `y >= text.y + text.height + gap` using the target's latest bounds.
- Missing placement no longer stacks generated media over existing elements at `(0, 0)`.
- Retrying attachment does not create duplicate elements.
