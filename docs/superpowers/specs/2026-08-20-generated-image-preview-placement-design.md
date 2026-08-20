# Generated Image Preview and Placement Design

## Problem

Agent-generated images complete successfully but expose two inconsistent results:

- Chat receives a relative `/api/assets/:assetId` artifact URL and renders it against the static Web origin, while the asset route belongs to the API origin.
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

### Artifact URL resolution

Add a small Web helper that leaves absolute and data URLs unchanged and resolves API-relative URLs against `NEXT_PUBLIC_SERVER_BASE_URL`. `ImageArtifactCard`, detail previews, lightbox, and download must use the same resolved URL. Invalid URLs render the existing failed-preview state and log bounded diagnostic context without exposing tokens.

The server continues returning `/api/assets/:assetId`, keeping storage implementation details private.

### Placement contract

Add optional `placementX`, `placementY`, `placementWidth`, and `placementHeight` fields to `SubmitImageJobFn`. Forward them from `runImageGenerate` into the runtime submission closure. `createAgentAttachmentContext` then persists either:

- `explicit`, when both coordinates are supplied, with dimensions; or
- `auto_right`, when coordinates are absent.

Partial coordinates remain invalid for explicit placement and fall back as a pair, matching current schema behavior.

### Automatic placement

At attachment preparation time, use the latest canvas content to place the generated element. The algorithm uses the union bounds of live elements, adds a fixed layout gap, and chooses a position immediately to the right of those bounds. For an empty canvas it uses the canvas origin. Generated dimensions retain aspect ratio and remain capped by the existing media maximum.

The placement is computed during the optimistic commit loop so retries use the latest canvas revision. Explicit placement bypasses this calculation.

### Observability and errors

Add structured logs for artifact URL resolution failures and attachment placement decisions. Logs include job, canvas, placement kind, and bounded coordinates, but no signed URLs, prompts, or access tokens.

Existing attachment recovery behavior remains unchanged: generation success and attachment completion stay separate states.

## Testing

- Web unit tests prove API-relative image artifacts resolve to the configured server origin and absolute URLs remain unchanged.
- Runtime tests prove all four placement fields cross the async submission boundary and produce an explicit attachment intent.
- Canvas attachment tests prove explicit coordinates are preserved, automatic placement is right of existing live content with a gap, and empty canvases use the origin.
- Existing attachment recovery, tool governance, chat rendering, type checks, and builds remain green.
- A browser smoke test verifies the thumbnail loads and the generated image appears below/right according to explicit Agent coordinates without overlapping the target text.

## Success Criteria

- The chat thumbnail and download use a browser-reachable API URL.
- A request to place an image below a known text element results in `y >= text.y + text.height + gap` when the Agent supplies explicit placement.
- Missing placement no longer stacks generated media over existing elements at `(0, 0)`.
- Retrying attachment does not create duplicate elements.
