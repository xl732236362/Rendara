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
  inputImages?: string[];
  jobId?: string;
  idempotencyKey?: string;
  errorMessage?: string;
};
```

`idempotencyKey` identifies one user-visible generation attempt. It is created
once before submission and is retained across request retries, remounts, and
project reloads. `jobId` is attached after the server accepts the submission.

The prompt, model, aspect ratio, quality, and reference images already stored
on the element form the replayable submission payload. The shared image-job
request contract is extended to accept `input_images`, matching the worker
payload that already supports them.

A deliberate user retry clears the previous terminal error and starts a new
attempt with a new idempotency key. Transport retries and recovery of the same
attempt reuse the existing key. This distinction prevents duplicate charging
while still allowing the user to request another image.

`completed` is transitional compatibility data only: successful reconciliation
replaces the generator rectangle with an Excalidraw image, so no completed
generator placeholder remains in the normal scene.

## Submission Flow

When the user selects Generate:

1. Validate the current generator settings.
2. Create a new idempotency key for this attempt.
3. Persist the element as `generating` with that key and no stale `jobId` or
   error.
4. Submit the image job with the same key plus project and canvas identifiers.
5. Persist the returned `jobId` on the same live element.
6. Register the job with the canvas reconciler.

Persisting the attempt before submission closes the important handoff gap. If
the browser disappears after the server accepts the request but before the
`jobId` is written back, the next canvas load finds a generating element with
an idempotency key but no job ID and resubmits the identical payload with the
same key. The server returns the original job rather than creating or charging
for a duplicate.

Submission failures are classified as follows:

- transient transport failures keep the element in `generating`, because the
  server may have accepted the request; recovery resubmits with the same key;
- deterministic validation or authorization failures set the element to
  `error` with a retryable message; and
- a missing idempotency key on legacy generating data becomes a recoverable
  error rather than an unprotected new submission.

The panel no longer waits for provider completion and therefore is not subject
to the current 30-second browser request timeout.

## Canvas-Level Reconciliation

After the canvas scene and authentication context are ready, the reconciler
scans all non-deleted image-generator elements whose status is `generating`.
It maintains one in-memory poll per job ID and deduplicates repeated scene
updates.

For each element:

- `jobId` present: fetch the job immediately, then poll while it is queued,
  running, or cancel-requested;
- `jobId` absent and `idempotencyKey` present: replay submission with the same
  payload and attach the returned job ID; or
- neither identifier present: mark the legacy element as a retryable error.

Polling uses a bounded interval with transient-error backoff and does not turn
a temporary network failure into a job failure. Polls stop when the element is
deleted, the job reaches a terminal state, the canvas changes, authentication
is lost, or the editor unmounts. Unmounting only stops browser polling; it does
not cancel server work.

The maximum duration of one mounted polling session is a resource guard, not a
terminal job judgment. If reached, the element remains `generating`; a later
scene change or project reload may reconcile it again. Logs include shortened
canvas, element, job, status, and attempt identifiers without logging prompts,
tokens, or reference-image contents.

## Successful Completion

For a `succeeded` job, the reconciler validates that the result contains a
usable asset identity and expected image metadata. It resolves a currently
authorized asset URL through the asset API instead of treating a worker URL as
permanently valid.

Immediately before replacement, it looks up the placeholder again in
`getSceneElements()`:

- if the element is missing or deleted, no canvas element is inserted;
- if its stored `jobId` no longer matches, the result is stale and ignored;
- otherwise, the image file is registered with Excalidraw and the placeholder
  is replaced atomically with a native image element.

The new image inherits the placeholder's current `x`, `y`, `width`, `height`,
`angle`, grouping/frame relationships, and other placement metadata required by
Excalidraw. Geometry captured at submission time is never used. This preserves
user movement, resize, and rotation performed while generation was running.

Result application is idempotent. Repeated successful fetches cannot insert a
second image because replacement requires the live generator element with the
matching job ID. The generated asset remains in project storage when its
placeholder was deleted; recovery must not recreate deleted canvas content.

## Failure And Retry

The terminal statuses `failed`, `dead_letter`, and `canceled` stop polling and
change the matching live placeholder to `error`. The element keeps its prompt
and settings, exposes the existing retry action, and stores a concise
user-facing message. Raw provider and server details are logged with job
context but are not shown directly to the user.

Retry starts a new attempt only in response to an explicit user action. It
creates a new idempotency key, clears the old job ID and error, persists the new
generating state, and submits normally. Double-clicks or rerenders during that
attempt reuse its key and cannot create duplicate jobs.

The existing duplicate console path is removed: the generation error handler
owns expected application-error reporting and toast presentation, while the
panel does not emit a second log for the same failure. Expected asynchronous
continuation and transient polling errors use structured informational or
warning logs rather than framework error overlays.

## API And Compatibility Changes

The web API client gains focused helpers for image-job submission and job
fetching using the shared schemas. Canvas submission includes `project_id` and
`canvas_id` when available. The shared `createImageJobRequestSchema` and server
route pass `input_images` through to the already-supported worker payload.

The server's idempotency guarantee remains authoritative. A repeated request
with the same workspace, creator, job type, and idempotency key must return the
original job and must not reserve or deduct credits again. Client-side poll and
click guards improve interaction quality but are not treated as the financial
correctness boundary.

Legacy generator nodes without attempt metadata remain editable. Idle and
error nodes can start a new protected attempt. A legacy node marked generating
without either identifier is changed to an error state asking the user to
retry; the system does not guess whether an untracked server request exists.

## Verification

Focused tests cover:

- Generate persists an attempt key, submits one background job, attaches its
  job ID, and does not invoke the synchronous generation API.
- Reference images, project ID, canvas ID, model, ratio, and quality reach the
  job request.
- Repeated submission of one attempt uses one idempotency key; an explicit
  retry creates a different key.
- A reload with `jobId` immediately resumes status reconciliation without
  selecting the node.
- A reload between submission and job-ID persistence replays with the same key
  and attaches the original job.
- Queued and running states continue polling through transient fetch failures.
- Success replaces the placeholder once and preserves its latest geometry and
  rotation.
- A deleted placeholder is not recreated after success.
- A job result for an obsolete job ID cannot replace a newer attempt.
- Failed, dead-letter, and canceled jobs become retryable error nodes.
- Unmount stops browser timers without canceling the server job.
- The same expected failure is not logged twice.

Shared contract tests verify `input_images`, required idempotency keys, and
response parsing. Server integration tests verify same-key submission returns
the original job and does not duplicate credit accounting. Existing canvas
generation tests, web type checking, affected server tests, and production
build verification remain required.

## Non-Goals

- Canceling background generation when a user leaves or deletes a node.
- Recreating a deleted placeholder when its job succeeds.
- Showing provider-specific progress percentages.
- Migrating unrelated agent-driven image or video generation flows.
- Removing the synchronous compatibility endpoint in this change.
- Changing provider timeout, retry, or image-quality behavior.
