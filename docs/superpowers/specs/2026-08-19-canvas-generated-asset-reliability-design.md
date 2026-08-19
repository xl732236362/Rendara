# Canvas Generated Asset Reliability Design

## Problem

Image generation can succeed while insertion into the canvas fails. The browser currently persists every hydrated Excalidraw `onChange` callback without checking whether durable content changed, continuously advancing the canvas revision. Generated-asset insertion then races those full-scene saves. If all optimistic-concurrency retries conflict, the runtime logs the insertion error but still returns a successful generation result. Canonical tool completion also drops the image artifact, and the agent stream has no inactivity deadline after its first event, so the UI can remain permanently busy.

## Goals

- Persist browser canvas state only when durable elements, durable app state, or serialized files actually change.
- Make generated-asset attachment an idempotent server-side canvas operation with the job/effect identity as its stable operation key.
- Report image generation as attached only after a durable canvas element and attachment receipt exist.
- Preserve generated image artifacts in canonical tool events so the UI can offer recovery without becoming the source of truth.
- Terminate inactive streams and reconcile abandoned attempts to a terminal state.
- Add structured diagnostics at each boundary needed to distinguish generation, attachment, conflict, and stream failures.

## Non-goals

- Replacing the complete canvas persistence model with CRDT collaboration.
- Moving authoritative canvas attachment to the browser.
- Changing image-generation providers or prompt behavior.

## Design

### Browser persistence

Introduce a deterministic durable-scene fingerprint over the exact payload sent by autosave: non-deleted elements, persisted app-state fields, and serialized files. Initialize the last-saved fingerprint from the hydrated scene. Excalidraw callbacks that change only selection, viewport, or other transient state continue to update local UI behavior but do not schedule a canvas save or thumbnail upload.

After a successful save, record the submitted fingerprint. Pending and in-flight fingerprints prevent duplicate saves while preserving the existing serialized save chain. A failed save does not advance the saved fingerprint. Remote or durable mutations update the fingerprint after their persistence operation so the following Excalidraw callback cannot echo the same state back to the server.

### Generated-asset attachment

Keep the server as the authoritative writer. Attachment uses the existing generated-asset application boundary and a stable operation identity derived from the generation job and effect key. The operation reads the newest scene, checks whether the operation was already applied, appends only the generated element/file, and conditionally commits. A revision conflict causes a fresh read and merge with bounded backoff; retries never reuse a stale merged scene.

Successful completion requires both a durable element identifier and a `generated_asset_attached` receipt. Replaying the same operation returns the original attachment result rather than creating a duplicate element.

### Failure and artifact propagation

Generation success and canvas attachment success are separate states. If the image exists but attachment exhausts retries, the tool returns a typed attachment failure containing the job ID and recoverable image artifact. The agent must not claim that the image was added.

Canonical tool completion preserves bounded structured output and image artifacts from `ToolMessage`, rather than retaining only a textual summary. The frontend may present a retry action using that artifact, but it must call the authoritative attachment operation; it must not silently insert a browser-only element.

### Stream termination and recovery

Apply an inactivity deadline to every wait for the next adapted model event, not only the first event. Tool execution may renew activity through emitted events. On expiry, abort the model stream, close open tool calls, finalize the attempt and run as failed with a stable timeout code, and emit a terminal event.

Expired running attempts are reconciled by the existing run acquisition/recovery path or a focused sweeper. Reconciliation must be fenced so an old worker cannot finalize a newer attempt.

### Observability

Structured logs include run ID, attempt ID, canvas ID, job ID, logical tool-call ID, operation ID, expected/current revision, retry count, attachment result, and timeout phase. URLs, prompts, tokens, and image bytes are excluded.

## Data Flow

1. The image worker stores the generated asset and records `generation_result`.
2. The image tool requests attachment using the stable operation identity.
3. The attachment application service reads the latest canvas, idempotently merges the generated element, and conditionally commits.
4. On conflict it rereads and repeats; on success it records `generated_asset_attached` and returns `elementId` plus revision.
5. Only then does the tool emit successful structured output and artifacts.
6. The canonical event reaches the UI; the browser receives the authoritative canvas update without echo-saving an unchanged scene.
7. Any exhausted attachment retry or stream inactivity produces a terminal failure instead of an indefinitely running task.

## Testing

- Browser unit tests prove identical durable payloads do not save, while element/file changes save once.
- Attachment tests force successive revision conflicts, verify fresh merges, and verify idempotent replay creates one element and one receipt.
- Runtime tests prove attachment failure is propagated and cannot produce a successful tool result.
- Governance tests prove image artifacts survive canonical projection within size limits.
- Stream tests prove inactivity after a successful first event produces a terminal timeout and finalizes the attempt.
- Recovery tests prove an expired attempt is finalized or safely reacquired with fencing.
- Existing web and server suites, type checking, and the production build remain green.

## Acceptance Criteria

- An idle open canvas does not continuously increment its revision.
- A generated image is either durably attached exactly once or visibly reported as generated-but-not-attached.
- A success result always contains a durable `elementId` and matching attachment receipt.
- No agent run remains `running` indefinitely after its stream stops producing events.
- Logs identify the exact failed boundary without exposing sensitive payloads.
