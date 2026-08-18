# Resumable Canvas Image Generation Design

## Goal

Move canvas image generation from a browser-bound synchronous request to the
existing durable background-job system. Once a generation attempt is visible
on the canvas, it must continue while the user leaves the project and reconcile
automatically when the project is opened again.

The finished behavior is:

- submitting a generator node creates one durable image-generation job;
- leaving or closing the project does not cancel that job;
- reopening the canvas discovers all unfinished generator nodes without
  requiring selection;
- successful jobs replace their live placeholders with native Excalidraw image
  elements;
- running jobs resume polling;
- terminal failures leave retryable generator nodes; and
- replaying the same attempt cannot create a second job or charge credits
  twice.

## Ownership And Boundaries

The server background job is the source of truth for execution, terminal
status, result metadata, and credit accounting. The Excalidraw generator
element is the durable canvas-side link to that job and remains the source of
truth for the result's placement.

The selected-node panel owns user input and starts new attempts. A canvas-level
reconciler owns recovery and completion for every generator element, including
elements that are not selected. The reconciler is mounted with the canvas
editor rather than inside the panel, so closing the panel cannot interrupt
tracking.

This change reuses:

- `POST /api/jobs/image-generation` for idempotent submission;
- `GET /api/jobs/:jobId` for status and result reconciliation;
- the existing job worker for generation, storage, and asset creation; and
- the existing asset URL APIs for authenticated image retrieval.

The old synchronous image-generation endpoint remains temporarily available
for callers outside this canvas workflow. Removing it is a separate migration.

## Persistent Generator State

`ImageGeneratorData` gains attempt metadata:

```ts
type ImageGeneratorData = {
  type: "image-generator";
  status: "idle" | "generating" | "completed" | "error";
  prompt: string;
  model: string;
  aspectRatio: string;
  quality: string;
  referenceAssetIds?: string[];
  jobId?: string;
  idempotencyKey?: string;
  errorMessage?: string;
};
```

`idempotencyKey` identifies one user-visible generation attempt. It is created
with `crypto.randomUUID()` once before submission and is retained across
request retries, remounts, and project reloads. `jobId` is attached after the
server accepts the submission.

The prompt, model, aspect ratio, quality, and reference asset IDs stored on the
element form the replayable submission payload. Raw files, data URLs, signed
URLs, and object paths are not stored in element `customData`.

Adding a reference image first uploads it through the existing project asset
API. Only the returned asset ID is attached to the generator element. Removing
a reference detaches it from the element but does not delete the underlying
asset, because that asset may be referenced elsewhere. A failed upload leaves
the reference unattached and blocks generation until the user removes or
successfully retries it.

The shared image-job request contract gains `input_asset_ids`. At execution
time, the server verifies that each asset belongs to the submitting workspace
and project, then resolves fresh worker-usable URLs immediately before calling
the provider. Signed URLs are never treated as durable state. Existing
`input_images` support remains internal compatibility behavior for other job
producers and is not exposed as the canvas persistence format.

A deliberate user retry clears the previous terminal error and starts a new
attempt with a new idempotency key. Transport retries and recovery of the same
attempt reuse the existing key. This distinction prevents duplicate charging
while still allowing the user to request another image.

Prompt, model, ratio, quality, and reference asset IDs are immutable while an
attempt is `generating`. The panel renders them read-only and all mutation
helpers enforce the same rule. Movement, resize, rotation, grouping, and
deletion remain allowed because they change placement rather than the request
fingerprint. Editing generation inputs becomes available again only after a
terminal error and creates a new attempt key on the next Generate action.

`completed` is transitional compatibility data only: successful reconciliation
replaces the generator rectangle with an Excalidraw image, so no completed
generator placeholder remains in the normal scene.

## Submission Flow

When the user selects Generate:

1. Acquire a synchronous per-element submission guard before the first await.
2. Validate the current generator settings.
3. Create a new idempotency key for this attempt.
4. Apply the element as `generating` with that key and no stale `jobId` or
   error, then await an immediate durable canvas save.
5. Submit the image job with the same key plus project and canvas identifiers.
6. Register the returned `jobId` with the canvas reconciler immediately.
7. Persist that `jobId` on the same live element.

The submission guard is owned by the canvas-level reconciler in a ref-backed
operation registry, not React render state or the selected-node panel. A second
click in the same render frame cannot create another key, and closing the panel
does not release an active operation. Once the durable generating state exists,
the element's stored key is authoritative and remounts reuse it. The reconciler
uses the same
`elementId + idempotencyKey` operation identity to deduplicate concurrent
recovery submissions triggered by scene changes. Server idempotency remains
the final financial boundary if requests still overlap.

The canvas editor exposes a focused durable mutation operation for generation
attempts. It updates the live Excalidraw scene, cancels any pending debounced
save, snapshots the current scene, serializes the save through the existing
revision-aware save chain, and resolves only after the server accepts the new
canvas revision. The panel does not call the ordinary debounced `onChange`
path and assume that an in-memory `updateScene()` is durable.

The durable mutation and normal `onChange` saver share one coordinator. The
coordinator suppresses or absorbs the `onChange` emitted by its own scene
update so that a delayed snapshot cannot overwrite the acknowledged revision.
All later user edits remain serialized after the durable mutation and are
saved normally.

An explicit revision conflict or validated 4xx save rejection proves that the
initial attempt was not committed: no job is submitted, the element is restored
to an editable error state in memory, and the existing reload/conflict workflow
is shown. Generation is not allowed to bypass that workflow.

A timeout, connection loss, or 5xx response is an ambiguous save outcome. The
client keeps the same attempt key in a non-editable submitting state and reads
the authoritative canvas revision before deciding what to do:

- if the server canvas contains the matching generating element and key,
  submission proceeds with that key;
- if a successful read proves the key is absent, the local attempt is rolled
  back and the user may retry; or
- if confirmation is still unavailable, no job is submitted and no new-key
  action is exposed; confirmation retries with backoff or resumes on reload.

This rule prevents the UI from claiming that an attempt failed when its save
may actually have committed and later triggered recovery.

This acknowledged save closes the first handoff gap. If the browser disappears
after the server accepts the request but before the `jobId` is saved, the next
canvas load finds a durably stored generating element with an idempotency key
but no job ID and resubmits the identical payload with the same key. The server
returns the original job rather than creating or charging for a duplicate.

Writing the returned `jobId` also uses the durable mutation operation. Polling
does not wait for this second save: the reconciler keeps an in-memory
`elementId + idempotencyKey + jobId` association and begins with an immediate
status fetch. If job-ID persistence fails, it retries that save with bounded
backoff while continuing to reconcile the known job. The already-durable
attempt key remains sufficient to replay submission and recover the original
job ID after a reload.

Submission failures are classified as follows:

- transient transport failures keep the element in `generating`, because the
  server may have accepted the request; recovery resubmits with the same key;
- deterministic validation or authorization failures set the element to
  `error` with a retryable message; and
- a missing idempotency key on legacy generating data becomes a recoverable
  error rather than an unprotected new submission.

The panel no longer waits for provider completion and therefore is not subject
to the current 30-second browser request timeout.

Every asynchronous mutation captures its attempt key. Before attaching a job
ID, recording a submission error, changing terminal status, or applying a
result, it verifies that the live element still has that same key. An older
request is ignored when a newer attempt has replaced the key. This
compare-and-set rule is required even when the UI normally disables duplicate
clicks, because reload recovery and network responses may race.

## Canvas-Level Reconciliation

After the canvas scene and authentication context are ready, the reconciler
scans all non-deleted image-generator elements whose status is `generating`.
It maintains one in-memory poll per job ID and deduplicates repeated scene
updates.

For each element:

- `jobId` present: fetch the job immediately, then poll while it is queued,
  running, failed-but-retryable, or cancel-requested;
- `jobId` absent and `idempotencyKey` present: replay submission with the same
  payload and attach the returned job ID; or
- neither identifier present: mark the legacy element as a retryable error.

Every fetched job is treated as untrusted relative to client-authored canvas
data. Before consuming its status or result, the reconciler requires
`job.id === jobId`, `job.job_type === "image_generation"`, and exact matches
for the current `project_id`, `canvas_id`, and authenticated `created_by` user.
A mismatch stops reconciliation for that node and durably records a generic
integrity error; it never attaches the foreign result. The existing
creator-scoped job RLS remains defense in depth but does not replace these
context checks, because one user may own jobs on multiple canvases.

Polling uses exponential backoff capped at a fixed maximum interval and does
not turn a temporary network failure into a job failure. A `failed` job is not
terminal in the existing worker state machine: it remains generating and keeps
polling because the queued message may be retried. Only `succeeded`,
`dead_letter`, and `canceled` are terminal for reconciliation.

There is no mounted-session time limit that silently abandons a generating
node. Polls stop when the element is deleted, the job reaches a terminal state,
the canvas changes, authentication is lost, or the editor unmounts. Unmounting
only stops browser polling; it does not cancel server work. Logs include
shortened canvas, element, job, status, and attempt identifiers without logging
prompts, tokens, or reference-image contents.

Polling and recovery errors have explicit meanings:

- network failures, timeouts, rate limits, and server 5xx responses keep the
  attempt generating and retry with backoff;
- 401 pauses reconciliation without changing node state, and restoration of
  authenticated context triggers a full generating-node rescan;
- 403 with otherwise valid authentication becomes a durable authorization
  integrity error and never exposes the foreign result;
- a 404 for a stored job ID triggers one deduplicated submission replay with
  the same immutable payload and attempt key, then replaces the job ID only if
  the attempt compare-and-set still matches;
- `idempotency_conflict` and job-context mismatches are durable integrity
  errors and never trigger an automatic new key; and
- parsing or result-contract failures become the terminal reconciliation
  errors defined below.

Deleting a generating placeholder is a critical canvas mutation. Detection of
the live-to-deleted transition immediately persists the deletion through the
same revision-aware save coordinator rather than waiting for the normal
debounce. Result application checks the live deletion before and after asset
download and cannot replace the node while its deletion save is pending. Once
the deletion revision is acknowledged, later reconciliation cannot recreate
the element. A save conflict uses the existing visible canvas-conflict flow;
the client does not claim that an unacknowledged deletion is durable.

## Successful Completion

For a `succeeded` job, the reconciler validates that the result contains a
usable `asset_id`, MIME type, and image dimensions. It resolves a currently
authorized asset URL through the asset API instead of treating a worker URL as
permanently valid. A succeeded job with missing or invalid result data, an
authenticated asset 404/403, or a non-image MIME type is a terminal
reconciliation error: the matching generator becomes `error`, polling stops,
and structured logs retain the job and validation context. Network errors,
timeouts, rate limits, and asset API 5xx responses remain transient and retry
with the polling backoff.

Immediately before replacement, it looks up the placeholder again in
`getSceneElements()`:

- if the element is missing or deleted, no canvas element is inserted;
- if its stored `jobId` or `idempotencyKey` no longer matches the captured
  attempt, the result is stale and ignored;
- otherwise, the image file is registered with Excalidraw and the placeholder
  is replaced atomically with a native image element.

The new image inherits the placeholder's current `x`, `y`, `width`, `height`,
`angle`, grouping/frame relationships, and other placement metadata required by
Excalidraw. Geometry captured at submission time is never used. This preserves
user movement, resize, and rotation performed while generation was running.

The runtime Excalidraw file receives the fetched data URL so the image can
render immediately. Its durable canvas file entry is
`{ id, mimeType, created, assetId }`; it does not contain the data URL or a
temporary signed URL. The image element continues to reference that entry by
`fileId`. On canvas load, the editor resolves a fresh authorized URL from the
entry's `assetId`, downloads the image into the runtime file map, and preserves
the asset ID for the next save. The canvas save serializer must therefore
retain `assetId` metadata and omit generated binary `dataURL` content; existing
embedded or uploaded file formats remain compatible.

Replacing the generator and persisting the asset-backed image uses one
revision-aware durable canvas mutation. If that save fails, the local scene
does not claim durable completion. It restores the matching generator with the
same `generating`, `jobId`, and `idempotencyKey` state, shows a nonterminal
canvas-save warning, and retries persistence with bounded backoff. It must not
offer a new generation retry for a job that already succeeded. Reloading the
server-stored generator allows the reconciler to consume the same successful
job again without another charge.

Result application is idempotent. Repeated successful fetches cannot insert a
second image because replacement requires the live generator element with the
matching job ID. The generated asset remains in project storage when its
placeholder was deleted; recovery must not recreate deleted canvas content.

## Failure And Retry

The terminal statuses `dead_letter` and `canceled` stop polling and durably
change the matching live placeholder to `error`. A `failed` status remains in
the generating state because the worker may retry it. The element keeps its
prompt and settings, exposes the existing retry action only after a terminal
status, and stores a concise user-facing message. Raw provider and server
details are logged with job context but are not shown directly to the user.

Retry starts a new attempt only in response to an explicit user action. It
creates a new idempotency key, clears the old job ID and error, durably persists
the new generating state, and submits normally. Double-clicks or rerenders
during that attempt reuse its key and cannot create duplicate jobs. Late
responses from the prior attempt fail the attempt-key compare-and-set check.

The existing duplicate console path is removed: the generation error handler
owns expected application-error reporting and toast presentation, while the
panel does not emit a second log for the same failure. Expected asynchronous
continuation and transient polling errors use structured informational or
warning logs rather than framework error overlays.

## API And Compatibility Changes

The web API client gains focused helpers for image-job submission and job
fetching using the shared schemas. Canvas submission requires `project_id` and
`canvas_id` for this workflow. The shared `createImageJobRequestSchema` and
server route accept `input_asset_ids`; the application layer includes those IDs
in the request fingerprint so replaying one key with different references
returns `idempotency_conflict`. The worker resolves and authorizes those assets
before adapting them to the provider's existing `input_images` input.

Reference assets are authorized against the submitting workspace and project
before atomic job creation and credit deduction, then checked again by the
worker in case an asset was removed while queued. The generated `asset_objects`
row is written with the job's `project_id` and `generation_job_id`, so output
authorization and project lifecycle match the canvas that requested it.

The server's idempotency guarantee remains authoritative. A repeated request
with the same workspace, creator, job type, and idempotency key must return the
original job and must not reserve or deduct credits again. Client-side poll and
click guards improve interaction quality but are not treated as the financial
correctness boundary.

The generation submission adapter must preserve the database's replay
semantics. A newly created submission is valid only when its job is `queued`;
an outcome marked `replayed` may return the original job in any valid current
status, including `queued`, `running`, `failed`, `cancel_requested`,
`succeeded`, `dead_letter`, or `canceled`. The image-job route returns the
current `JobResponse`, and the client immediately reconciles that status. It
must not coerce a replayed job to `queued` or reject it merely because work
advanced while the browser was away.

Legacy generator nodes without attempt metadata remain editable. Idle and
error nodes can start a new protected attempt. A legacy node marked generating
without either identifier is changed to an error state asking the user to
retry; the system does not guess whether an untracked server request exists.

## Verification

Focused tests cover:

- Generate persists an attempt key, submits one background job, attaches its
  job ID, and does not invoke the synchronous generation API.
- A generation job is not submitted until the attempt save is acknowledged or
  authoritatively confirmed; explicit rejection and revision conflict submit
  no job.
- An ambiguous initial-save timeout confirms the authoritative canvas before
  either submitting or exposing a new attempt; it cannot cause a surprise or
  duplicate charge.
- Reload recovery works when job-ID persistence fails after successful
  submission.
- The current mounted canvas continues polling a submitted job when job-ID
  persistence fails; it does not require a reload to finish.
- Reference images upload once; only asset IDs enter the canvas and job
  request, and unauthorized or missing assets are rejected.
- Repeated submission of one attempt uses one idempotency key; an explicit
  retry creates a different key.
- Same-frame double clicks and concurrent recovery scans cannot create two
  attempt keys or two charged jobs.
- A reload with `jobId` immediately resumes status reconciliation without
  selecting the node.
- A reload between submission and job-ID persistence replays with the same key
  and attaches the original job.
- Same-key recovery returns the original job when it has already advanced to
  queued, running, retryable failed, cancel-requested, succeeded, dead-letter,
  or canceled state.
- Queued, running, cancel-requested, and retryable failed states continue
  polling through transient fetch failures; only real terminal states stop.
- Authentication loss pauses without exposing retry, authentication recovery
  resumes automatically, and job 404 recovery replays only the same key.
- Success replaces the placeholder once and preserves its latest geometry and
  rotation.
- A deleted placeholder is not recreated after success.
- A job result for an obsolete job ID cannot replace a newer attempt.
- A same-user job from another canvas, project, or media type fails context
  validation and cannot be attached.
- A late submission response cannot attach its job ID after the element starts
  a newer attempt.
- Retryable failed jobs do not expose a new-generation action; dead-letter and
  canceled jobs become retryable error nodes.
- Succeeded jobs with invalid or inaccessible results become terminal,
  diagnosable error nodes rather than polling forever.
- Generated images persist asset IDs without embedding binary data or signed
  URLs, and reload resolves fresh authorized URLs.
- A failed result-replacement save retains the original successful job link
  and cannot expose an action that submits and charges for another job.
- Deleting a generating placeholder is saved immediately, races safely with
  completion, and an acknowledged deletion is never recreated.
- Unmount stops browser timers without canceling the server job.
- The same expected failure is not logged twice.

Shared contract tests verify `input_asset_ids`, required idempotency keys, and
response parsing. Server integration tests verify asset ownership, request
fingerprinting, same-key submission returning the original job in every valid
status, and no duplicate credit accounting. Canvas persistence tests cover
immediate save ordering, revision conflicts, asset metadata round trips, and
failure recovery.
Existing canvas generation tests, web type checking, affected server tests, and
production build verification remain required.

## Non-Goals

- Canceling background generation when a user leaves or deletes a node.
- Recreating a deleted placeholder when its job succeeds.
- Showing provider-specific progress percentages.
- Migrating unrelated agent-driven image or video generation flows.
- Removing the synchronous compatibility endpoint in this change.
- Changing provider timeout, retry, or image-quality behavior.
