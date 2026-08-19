# Canvas Generated Asset Reliability Design

## Problem

Media generation can succeed while attachment to the canvas fails. The browser currently persists every hydrated Excalidraw `onChange` callback without checking whether durable content changed, continuously advancing the canvas revision. The server then tries to attach a generated element by reading and rewriting the whole scene with optimistic concurrency. Repeated browser writes can exhaust all attachment retries.

The runtime currently logs attachment failure and still completes the generation tool. Canonical tool completion also discards the returned media artifact, and the model stream has no inactivity deadline after its first event. The resulting user-visible state is contradictory: the assistant says the media was attached, the canvas has no new element, and the run can remain busy indefinitely.

There is an additional data-loss risk: applying an authoritative `canvas.sync` snapshot while the browser has unacknowledged local edits can replace those edits.

## Goals

- Persist browser canvas state only when durable elements, durable app state, or serialized files actually change.
- Attach generated images and videos with an idempotent database transaction that does not race full-scene revision checks.
- Persist the attachment intent atomically with Agent generation submission so fulfillment survives runtime or WebSocket loss.
- Preserve concurrent, unacknowledged browser edits when applying an authoritative canvas update.
- Report Agent attachment success only after the canvas element, job receipt, outbox event, and Agent effect commit atomically; report recovery success only after the same durable canvas effects and recovery audit commit.
- Preserve a bounded recovery descriptor and display artifact when generation succeeds but attachment fails.
- Terminate genuinely inactive model streams without killing healthy long-running tools.
- Renew active attempt leases and terminally reconcile abandoned attempts.
- Add structured diagnostics and metrics at each failure boundary.

## Non-goals

- Replacing the complete canvas persistence model with CRDT collaboration.
- Moving authoritative generated-asset attachment to the browser.
- Changing media-generation providers, prompts, or billing semantics.
- General real-time multi-user collaboration. The merge behavior in this design protects local unsaved work during server-originated mutations only.

## Invariants

1. Any result that claims attachment has `attachmentStatus: "attached"`, a durable `elementId`, and a canvas revision. A permitted generate-only invocation uses `attachmentStatus: "not_requested"` and never claims that the canvas changed.
2. One `(job_id, effect_kind)` creates at most one canvas element and one job-effect receipt.
3. The deterministic element ID is the generation job ID. Once the attachment receipt exists, replays return its stored original result and never recreate, reposition, or otherwise modify the element; later user edits or deletion remain authoritative.
4. For an attachment fulfilled while its Agent attempt is still active, the canvas mutation, `generated_asset_attached` receipt, `canvas.updated` outbox event, attachment-intent completion, and Agent-effect completion commit in one database transaction. Fulfillment after the Agent attempt becomes terminal commits the same canvas effects and intent result but does not mutate terminal Agent state.
5. A browser save never overwrites an unseen server mutation. A revision conflict is resolved from the latest authoritative snapshot before another full-scene save.
6. A generated asset that is not attached is never represented as attached in tool output or assistant-visible tool content.
7. Signed URLs and image bytes are display data, not durable recovery identity. Recovery uses the authenticated job ID and canvas context.
8. Only the current fenced attempt can create an Agent attachment intent, renew its lease, or finalize a run. A claimed intent may be fulfilled after that attempt expires because authorization and scope were durably validated at intent creation; late fulfillment cannot change terminal Agent run state.

## Architecture

### 1. Durable browser persistence

Move autosave decisions into the existing save coordinator. Build a normalized durable payload from:

- non-deleted elements in scene order;
- only persisted app-state fields (`viewBackgroundColor` and `gridModeEnabled`); and
- `serializeCanvasFiles(...)` output.

Use the same canonical JSON routine for initialization, autosave, durable mutations, synchronization, and unload handling. It sorts object keys, omits `undefined`, and preserves array order; the durable fingerprint is SHA-256 of that UTF-8 representation.

Avoid re-hashing legacy base64 files on every transient callback. At debounce expiry, first compare a compact dirty signature made from element order plus each element's object identity, `id`, `version`, `versionNonce`, and deletion state; persisted app-state values; and file IDs plus stable file metadata/object identity. Only a changed compact signature builds and hashes the full durable payload. Cache each immutable serialized file entry's digest by file identity, and invalidate it when that entry changes. Excalidraw and every Loomic durable mutation helper must replace changed objects and increment element version metadata; development assertions reject helpers that violate that contract. Under this enforced mutation contract, a false-positive dirty hint causes extra work but a real durable change cannot be skipped. Asynchronous digest work runs inside the coordinator queue and discards results whose live generation token is stale.

The coordinator maintains four explicit values:

- `base`: the last authoritative revision, content, and fingerprint;
- `pending`: the latest local content waiting to be saved;
- `inFlight`: the immutable content and fingerprint currently being saved; and
- `live`: the current Excalidraw content.

An `onChange` callback may continue to update selection state, but it schedules durable work only when the debounced live fingerprint differs from both `base` and `pending`/`inFlight`. Thumbnail upload is triggered only after a local save acknowledgment or an authoritative remote content application, never by selection or viewport movement.

On save success, the coordinator advances `base` to the exact submitted content and returned revision. If live content changed while the request was in flight, it remains pending and is serialized as the next save. On failure, `base` is unchanged. A deterministic 409 enters synchronization; a transport or 5xx ambiguity first reads the authoritative canvas and compares content before deciding whether to retry.

The unload path sends only a real pending durable change. It does not create a placeholder pending payload. Because a keepalive response cannot safely advance local state during teardown, the next load always treats the server as authoritative.

### 2. Durable intent and transactional incremental attachment

When an Agent submits an image/video generation job with `canvas.mutate`, the generation submission transaction also inserts a `generated_asset_attachment_intents` row keyed by `(job_id, effect_kind)`. Intent creation validates the current Agent fence and existing reserved effect before the job can be enqueued. The intent stores only durable identity and policy: job/canvas/session/user/workspace/project, run/logical tool call/input digest, media type, allowlisted effect kind, and validated explicit placement or `auto_right`. It never stores a signed URL, prompt, raw media, or client-supplied object path.

This closes the process-loss gap: once generation submission is accepted, a durable intent exists before the background worker can complete. A focused attachment reconciler observes due intents whose jobs are terminal, claims succeeded jobs for fulfillment, and settles intents for canceled/dead-letter jobs without attachment. It runs in the durable worker process, scans on startup and on a bounded interval, and is also awakened by generation settlement. The live Agent runtime may request a wakeup and wait for the durable result, but it is not the sole attachment executor. Every trigger uses the same database claim protocol.

Agent-only attachment context is accepted through the internal generation submission port, not the public job request schema. Public requests cannot forge run IDs, fences, effect identities, placement policy, or intent fields. Idempotent generation submission returns the same job and same intent; the job, billing reservation, queue message, and intent commit or roll back together.

Intent claims use their own lease owner, expiry, attempt count, and fencing token. A stale fulfiller cannot commit. Retryable infrastructure failures move the intent to `retry_wait` with bounded exponential backoff; deterministic validation/integrity failures mark it `failed` and retain the generated job for authenticated recovery. Explicit Agent run cancellation does not revoke an already accepted attachment intent; canceling the generation job through its dedicated job-cancel operation does. This matches the existing durable-background-job contract and avoids charging for an inaccessible result.

The intent state machine is explicit:

```text
pending -> running -> attached
                 -> retry_wait -> running
                 -> failed
pending/retry_wait -> canceled (generation job canceled)
pending/retry_wait -> failed (generation job dead-lettered)
failed -> pending (authenticated recovery only)
```

`running` records claim owner, lease expiry, and fencing token. `retry_wait` records `next_attempt_at` plus a bounded public error code; `failed` records a deterministic error code; `attached` stores the receipt result. Exhausting the configured attempt count turns a retryable error into `failed` so work cannot retry forever. Claiming reclaims expired `running` rows with a new fence. Transitions and error codes are database-constrained.

Initial intent defaults are a 30-second claim lease, a 5-second scan interval, and at most eight fulfillment attempts with exponential delays of 1, 2, 4, 8, 16, 32, 60, and 60 seconds. Generation settlement requests an immediate scan, so the interval is only the missed-notification fallback. These values are validated configuration and exposed in metrics.

Replace the read/merge/conditional-full-save attachment loop with a dedicated service-role database RPC, `fulfill_generated_asset_attachment`. The internal reconciler loads the claimed intent, job, and asset; builds schema-validated Excalidraw element/file templates; and calls the RPC with the intent ID, intent claim fence, templates, and optional current Agent attempt fence used for effect completion. These template parameters exist only on the service-role repository port and are never accepted from HTTP. The RPC does not accept an expected canvas revision. For `auto_right`, it computes and patches final coordinates from the locked current scene; for explicit placement, it verifies the coordinates match the immutable intent.

The authenticated recovery endpoint accepts only job and canvas identity. It verifies current access and either requeues the existing failed intent or creates a legacy recovery intent with a deterministic key derived from user, canvas, job, and effect kind. It cannot supply Agent-effect fields. The recovery audit table has a unique constraint over that tuple.

Inside one transaction the RPC:

1. Locks records in one documented order: job, attachment intent, canvas, then any existing receipt, Agent effect, and recovery audit row. Every caller uses this order to prevent deadlocks; the locked canvas row plus unique constraints serialize the first insert when those rows do not yet exist.
2. Verifies the intent claim lease/fence and immutable job/canvas/user/workspace/project/media/effect scope captured at creation.
3. Verifies the job is `succeeded`, its `asset_id` resolves to an asset in that exact scope, and the asset media type matches the intent.
4. Checks the unique `(job_id, effect_kind)` receipt and deterministic element/file IDs.
5. If already committed, validates the receipt's job, canvas, effect kind, original `elementId`, and revision, marks the claimed intent completed with that result, then returns it without inspecting or changing the current element, file, placement, or canvas revision. The element may have been legitimately edited or deleted after attachment.
6. If no receipt exists but either deterministic ID is already occupied by different content, marks the intent as a deterministic integrity failure and does not overwrite it.
7. Otherwise builds and merges the one element and optional file entry into the latest `content` while holding the canvas row lock. Existing unrelated elements, app state, and files are preserved.
8. Increments the canvas revision once.
9. Inserts the `generated_asset_attached` receipt with `canvasId`, `elementId`, and revision.
10. Inserts the `canvas.updated` outbox event containing the revision and attachment identity.
11. Marks the intent completed with the exact attachment result and completes the recovery audit when present.
12. If the optional Agent attempt fence is still current, running, and unexpired, completes the reserved Agent effect with the same result. If the attempt is terminal or expired, skips effect completion without rolling back the durable attachment.

The intent/receipt unique key remains the cross-process, cross-run, and recovery idempotency boundary. The Agent-effect key `(run_id, logical_tool_call_id)` remains the within-run model replay boundary. The deterministic recovery key deduplicates audit rows; the canvas lock and receipt constraint deduplicate the attachment itself. A malformed receipt or one scoped to a different job/canvas is an integrity failure; absence or later modification of the once-attached element is normal scene evolution. Intent creation rejects arbitrary effect kinds and accepts only generated image/video attachment kinds.

Element and file templates are built and schema-validated from trusted job/asset/intent rows in the application repository boundary, then passed to the transaction without public overrides. The database RPC additionally validates required identifiers, provenance, and bounded object shape before applying placement and merging. Automatic right-side placement is finalized against the locked current scene; explicit Agent coordinates were range-checked at intent creation and are checked again before use.

The succeeded job must contain a valid `asset_id`. Image file entries persist `{ assetId, mimeType, created }` rather than base64 bytes. Video elements persist the asset ID in `customData` and use an authenticated same-origin media route for playback; they do not persist an expiring signed URL as their only link. Canvas load resolves fresh authorized media URLs from the asset ID. The same attachment path applies to generated images and videos.

### 3. Safe server-to-browser synchronization

Every acknowledged browser save records its content as the synchronization base. Save responses and synchronization requests execute through one coordinator queue so a `canvas.updated` event cannot race the response for the write that produced it. When `canvas.updated` announces a newer revision, the coordinator fetches the authoritative remote content and compares it with `base` and `live`:

- if local content equals `base`, apply remote content directly, register its files, and advance `base`;
- if local content differs from `base`, first verify the remote delta is an allowed server mutation: existing base elements/files are byte-for-byte unchanged in canonical durable form and the remote side only appends generated element/file IDs;
- for that allowed append-only delta, preserve the complete local element order and local changes, append the remote-only generated elements in remote order, and union remote-only files after collision checks;
- if remote changed, deleted, or reordered a base element/file while local is dirty, stop autosave and show the existing visible conflict workflow rather than attempting a general collaboration merge;
- if a remote-only ID collides with different local content, enter the same conflict workflow;
- deletion and element order are durable changes and participate in these comparisons.

After a conflict-free merge, update Excalidraw under autosave suppression, atomically advance the coordinator base to the fetched remote revision/content, then save the merged content if it differs from remote. Do not advance `revisionRef` separately from the corresponding authoritative base content.

Duplicate or out-of-order `canvas.updated` events are ignored by revision. If the WebSocket event is missed, reconnect, window focus, and run terminal handling compare the known revision with the server and invoke the same coordinator path. Applying remote content never uses the legacy artifact callback to create a browser-only element.

### 4. Tool outcome and recovery contract

Generation and attachment have distinct outcomes:

```ts
type GeneratedMediaToolResult =
  | {
      attachmentStatus: "attached";
      jobId: string;
      elementId: string;
      canvasRevision: number;
      artifact: ToolArtifact;
    }
  | {
      attachmentStatus: "not_requested";
      jobId: string;
      artifact: ToolArtifact;
    }
  | {
      attachmentStatus: "not_attached";
      jobId: string;
      recovery: { kind: "attach_generated_asset"; jobId: string; canvasId: string };
      artifact?: ToolArtifact;
      error: { code: string; message: string; retryable: boolean };
    }
  | {
      attachmentStatus: "pending";
      jobId: string;
      recovery: { kind: "watch_generated_asset"; jobId: string; canvasId: string };
      error: { code: "generated_asset_pending"; message: string; retryable: true };
    };
```

The intent fulfillment service returns `attached`. An invocation intentionally authorized for generation without `canvas.mutate` returns `not_requested`; tool content states only that media was generated. If the job or intent remains non-terminal when the tool wait deadline expires, the tool returns an error `ToolMessage` with `pending`; background generation and intent fulfillment continue, and the model is told not to regenerate. If generation succeeded but intent fulfillment reached a deterministic failure, the tool returns an error `ToolMessage` with `not_attached` and authenticated recovery metadata. The governance layer publishes both error cases as `loomic.tool.failed`, not `loomic.tool.completed`, and preserves validated recovery plus an optional display artifact. The model cannot truthfully claim attachment before `attached` exists.

The image and video tools use LangChain's installed `responseFormat: "content_and_artifact"` contract and return a two-tuple: concise model-visible content plus a private structured artifact. This matches the installed `@langchain/core` API, where the second tuple value becomes `ToolMessage.artifact` and is not sent to the model. A typed `GeneratedAssetAttachmentError` carries the same private recovery structure when attachment fails; governance catches it and constructs the error `ToolMessage`. Generation functions no longer convert this condition into an ordinary `{ error }` success object.

Extend the canonical failed-tool contract with optional, schema-validated `recovery` and `artifacts` fields. Do not project arbitrary `ToolMessage.artifact` objects. Projection recognizes only the shared media artifact schema and the explicit recovery schema, caps count and serialized bytes, strips unknown keys, rejects data URLs, and publishes media only through authenticated same-origin asset routes that mint or proxy fresh access. Prompts, signed provider/storage URLs, object paths, access tokens, and provider payloads are never published.

The shared chat `ToolBlock` and `chatToolActivity` contracts add status `failed`, the bounded public error, optional recovery descriptor, and optional artifacts. Stream reduction writes those fields on `tool.failed`; message persistence stores them; session reload restores them. The retry action is therefore durable across refresh and reconnect, not a transient callback. Generic tool failures without recovery remain valid failed blocks and show no retry action.

On initial render, reconnect, window focus, and relevant `canvas.sync`, the web client resolves persisted recovery descriptors through an authenticated attachment-status query. It also lists nonterminal or recoverable attachment intents scoped to the current canvas/session, covering process loss before a failed-tool event could be emitted. The query derives state from intent plus receipt and returns only job/tool identity plus `pending`, `attached` with element/revision, or `failed` with a bounded error and `canRetryAttachment` policy. It never exposes prompts, storage identity, or other sessions.

The UI derives its display state rather than rewriting the historical tool event: `pending` shows background progress with no regenerate action, `attached` shows successful recovery and removes Retry, and a recoverable `failed` offers Retry. An intent is joined to its originating tool block by run/logical tool-call identity; when no block survived the process loss, the chat shows one deduplicated recovery notice keyed by job ID. This prevents both a late background success from remaining visually failed after refresh and a pre-event crash from hiding recoverable media.

For `not_attached`, the retry UI calls the authenticated recovery endpoint with `jobId` and `canvasId`. The endpoint derives the stable recovery-operation key and requeues/creates the durable intent; it does not revive or complete the failed Agent attempt. For `pending`, the UI observes job/intent status and canvas events but offers no regenerate action. The server derives all asset metadata from the stored succeeded job. The client cannot supply an object path, success status, owner, media type, effect kind, placement, or final element ID. A retry after an ambiguous response is safe because the intent, operation record, receipt, and deterministic element ID are idempotent.

All background retries reuse the same job and intent. The model is explicitly told not to call the generation tool again for `pending` or `not_attached`, preventing a second generation charge. After a deterministic intent failure, only the authenticated recovery action requeues attachment.

Legacy `onImageGenerated`/`onVideoGenerated` callbacks remain only for non-Agent direct-generation flows. Agent canonical events never invoke them as an attachment fallback.

### 5. Phase-aware deadlines and leases

Do not use one short inactivity timeout for all stream phases. The runtime owns three independent controls:

- **First model event deadline:** existing deadline for a model that never starts.
- **Model inactivity deadline:** applies while no canonical tool call is open. Each model/message/tool lifecycle event resets it. Expiry raises `agent_model_inactivity_timeout`.
- **Tool deadline:** each tool owns a configured maximum duration. Image/video job polling emits internal progress heartbeats and remains valid until its own deadline; a healthy open tool is not killed by the model inactivity deadline. Other tools use their bounded execution deadline.

An overall run deadline remains longer than the longest allowed tool plus model finalization time and acts only as a final containment boundary. All deadline values are configuration with validated ordering, not duplicated literals.

Initial defaults are: 30 seconds to first model event, 90 seconds of model inactivity with no open tool, 5 minutes for image-tool waiting, 10 minutes for video-tool waiting, 2 minutes for other tools unless explicitly classified, and 20 minutes overall. Agent attempts use a 60-second lease renewed every 15 seconds; expired-run recovery uses a 30-second grace period. Startup validation requires each tool deadline below the overall deadline and the renewal interval below one third of the lease. Tool wait expiry does not cancel a durable generation job or attachment intent. With a dead process and no renewal, the default terminal-recovery bound is 90 seconds rather than the former 15-minute lease window.

While a run is active, a lease-renewal loop renews the current attempt before one third of its lease duration elapses. Renewal requires the attempt ID, fencing token, and lease owner, caps the extension to the configured lease duration, and does not depend on model tokens or WebSocket connectivity. Failure to renew before expiry aborts execution and prevents further effects. The loop stops on every terminal path and process shutdown.

On any deadline expiry, the runtime aborts the adapted stream, awaits/caps iterator cleanup, closes open tool calls, and atomically finalizes the current fenced attempt and run as failed before emitting the terminal event. Failure to confirm finalization is surfaced through the existing finalization-unconfirmed path rather than reported as a successful failure transition.

A periodic database recovery operation handles processes that disappeared before finalization. In one fenced transaction it finds only runs whose latest attempt is `running`, whose lease is expired beyond a configured grace period, and which have no newer accepted/running attempt; it marks that attempt and run failed with `agent_attempt_lease_expired` and writes an `agent.run.failed` terminal outbox event. Re-running the recovery operation is idempotent. Resume remains a separate user-driven operation that creates a new fenced attempt and must win safely against recovery under row locking.

The domain-event publisher gains explicit `agent.run.failed` validation and delivery. If the user currently has a connection, it emits the standard `run.failed` stream event. Lack of a live connection is not an outbox failure because the durable run status is authoritative; reconnect and page load query the run and clear stale streaming UI from that terminal status. Malformed events remain retryable/dead-lettered through the existing outbox policy.

### 6. Observability

Structured logs include run ID, attempt ID, canvas ID, job ID, logical tool-call ID, media type, effect kind, fencing token, old/new revision, merge outcome, attachment replay status, deadline phase, and retry count. They exclude prompts, URLs, tokens, object paths, raw tool output, and media bytes.

Metrics include:

- no-op autosaves suppressed;
- canvas save conflicts and three-way merge outcomes;
- generated-asset attachments, replays, failures, and integrity failures;
- attachment intents by state, oldest due age, claim reclamations, attempts, and time from generation settlement to attachment;
- tool failures with `not_attached` recovery;
- model inactivity and tool deadline expirations;
- lease renewal failures and expired-run recoveries; and
- age/count of non-terminal runs with expired leases.

Alerts are based on attachment integrity failures, sustained due-intent backlog, and sustained expired-run backlog, not individual recoverable conflicts.

Readiness verifies that the attachment-intent schema/RPCs are present and that the durable worker registered the reconciler. If attachment infrastructure is unavailable, a canvas-mutating generation request fails before job submission or billing reservation; it cannot silently downgrade to generate-only or the legacy attachment path.

## Rollout And Compatibility

1. Add database RPCs, allowlisted contracts, indexes/constraints, and pgTAP coverage while leaving them unused.
2. Deploy additive shared/server event support and the web save/sync coordinator. Keep recovery UI hidden until the server endpoint is live.
3. Verify coordinator telemetry on idle saves, conflicts, and remote merges before changing Agent attachment routing.
4. Route Agent image and video attachment through the new transaction and enable recovery UI. Any rollout kill switch fails closed as `not_attached`; it never routes Agent success through the old swallow-and-continue behavior.
5. Enable phase-aware deadlines and lease renewal, then enable the expired-run recovery job with metrics before alerts.
6. Remove the legacy Agent artifact insertion fallback after telemetry shows no callers for one release. Direct-generation UI behavior remains unchanged.

The shared event objects remain additively compatible: older Zod object schemas strip the new optional failed-tool fields and still receive a terminal tool/run failure. Contract tests lock this behavior. Older persisted completed effects without `canvasRevision` are accepted as attached only when a matching attachment receipt exists. The migration normalizes the replay response from that receipt and deterministic element ID without requiring the element to still be present; a completed effect without a matching receipt is an integrity failure for operator repair.

## Component Ownership

- `apps/web/src/lib/canvas-persistence.ts` owns canonical durable content, the save/sync coordinator state machine, and append-only remote merge rules.
- `apps/web/src/components/canvas-editor.tsx` adapts Excalidraw callbacks to that coordinator and never owns revision transitions independently.
- `apps/web/src/app/canvas/page.tsx` forwards `canvas.sync`, reconnect, focus, and terminal-run reconciliation triggers into the coordinator; it does not apply fetched scenes directly.
- `apps/web/src/components/chat-sidebar.tsx` renders failed attachment recovery and does not invoke Agent artifact insertion callbacks.
- `packages/shared/src/artifacts.ts` and `packages/shared/src/events.ts` own bounded media, recovery, and failed-tool wire contracts.
- `packages/shared/src/contracts.ts` owns persisted failed tool-block/activity status and recovery metadata.
- `apps/server/src/application/canvas/attach-generated-asset.ts` owns authorization-neutral attachment commands and the two explicit modes.
- `apps/server/src/features/canvas/generated-asset-application-adapter.ts` derives trusted job-backed media data and calls the incremental repository operation.
- `apps/server/src/features/canvas/canvas-repository.ts` maps database results/errors; ordinary full-scene saves remain revision-checked.
- `apps/server/src/http/jobs.ts` exposes authenticated generated-asset recovery, attachment-status, and canvas/session-scoped outstanding-intent endpoints; all return bounded state.
- A focused generated-asset attachment reconciler owns intent claiming, backoff, fulfillment, and generation-success wakeups; it shares no in-memory correctness state with the Agent runtime.
- The generation submission application/repository owns atomic creation of Agent attachment intents alongside jobs.
- A new Supabase migration owns the attachment-intent and recovery-audit tables, intent claim/settle and attachment RPCs, lease-renewal RPC, expired-run recovery RPC, constraints, and grants. Only `service_role` can execute these RPCs.
- `apps/server/src/agent/tools/image-generate.ts` and `video-generate.ts` own LangChain `content_and_artifact` tool return values.
- `apps/server/src/agent/tool-governance-middleware.ts` owns typed `ToolMessage` projection and sanitization.
- `apps/server/src/agent/runtime.ts` owns phase-aware deadlines, tool progress integration, lease renewal lifecycle, and terminal finalization.
- `apps/server/src/events/domain-event-publisher.ts` owns recovered terminal event validation and connected-client delivery.

## Failure Semantics

| Condition | Tool state | Run behavior | User-visible outcome |
| --- | --- | --- | --- |
| Generation failed | failed | Model may explain or retry according to tool policy | Generation failed |
| Generate-only invocation succeeded | completed, `not_requested` | Continue | Media generated; no canvas-change claim |
| Generation/intent still pending at tool deadline | failed with `pending` recovery | Background work continues; do not regenerate | Still processing in background; sending is enabled |
| Generation succeeded, attachment recoverable failure | failed with recovery | Do not regenerate; finish with recovery guidance | Media generated but not attached; Retry action |
| Attachment committed, response lost | replayed attached success | Continue | One element only |
| Receipt exists but element was later edited/deleted | replay original attachment result | Continue without canvas mutation | User's later canvas state is preserved |
| Receipt is malformed or belongs to another canvas/job | failed integrity error | Fail run, alert | Attachment could not be verified |
| Concurrent local and remote edits to different IDs | merge then save | Continue | Both changes preserved |
| Concurrent edits to the same existing ID | synchronization conflict | Stop autosave until user reloads/resolves | Existing conflict UI |
| Model silent with no open tool | failed after model inactivity deadline | Terminal failure | Sending is re-enabled |
| Healthy long-running generation tool | running with internal heartbeats | Continue until tool deadline | Progress remains active |
| Attempt lease expires after process loss | recovered as failed | Terminal outbox event | Sending is re-enabled on reconnect |
| Runtime disappears after job submission | intent reconciler continues independently | Run is lease-recovered if needed | Media still attaches and syncs when ready |

## Testing

### Browser

- Identical durable payloads, selection changes, viewport changes, and remote echo callbacks do not save or upload thumbnails.
- Large legacy base64 files are not reserialized or rehashed for transient callbacks after their file digest is cached.
- A change arriving during an in-flight save is queued and saved after the first acknowledgment.
- Ambiguous save outcomes reconcile by reading authoritative content.
- A server-generated element merges with unsaved local edits and is then durably saved once.
- A sync event racing its originating save response is serialized by the coordinator and does not regress the base or create a redundant save.
- Same-element concurrent changes enter conflict handling without overwriting either source.
- Duplicate/out-of-order sync events and missed-event recovery do not regress revisions or duplicate elements.
- Unload sends nothing when only transient state changed.

### Application and runtime

- Attached success cannot be constructed without `elementId` and `canvasRevision`; generate-only success is explicitly `not_requested`.
- Attachment failures become canonical failed-tool events with bounded recovery data and cannot produce an attached assistant claim through tool content.
- A tool wait deadline emits `pending` once, does not cancel the job/intent, and cannot trigger a second generation charge.
- Missing attachment infrastructure rejects a canvas-mutating generation before job creation or billing.
- Canonical projection rejects arbitrary artifacts, data URLs, unknown recovery kinds, oversized output, and unsafe URLs.
- Older shared-event schemas safely strip new optional recovery fields while retaining the failed event.
- Failed attachment blocks preserve error, recovery, and artifact metadata through message persistence and session reload; generic failures do not render an attachment retry.
- Persisted recovery blocks derive pending/attached/failed display state from authenticated status on reload and after canvas sync.
- A process crash before `tool.failed` still surfaces one pending/recoverable notice from the canvas/session intent query, with cross-session data excluded.
- Agent image/video events never invoke browser-only attachment callbacks.
- A silent model after a completed tool reaches a terminal inactivity failure.
- A healthy open image/video tool survives the model inactivity interval but fails at its own deadline.
- Abort and iterator cleanup occur on every deadline path.
- Lease renewal keeps a healthy long run active; renewal failure fences later effects.
- Recovered `agent.run.failed` outbox events reach connected clients, while reconnect discovers the same terminal status without relying on event delivery.

### Database

- Concurrent browser full saves and attachment transactions retain both acknowledged changes without attachment retry livelock.
- Concurrent duplicate Agent attachment requests produce one deterministic element, one receipt, one revision increment, one outbox event, and one completed Agent effect.
- User recovery after terminal Agent failure attaches through a recovery audit operation without attempting to complete the stale Agent effect.
- Process termination after atomic job/intent submission still results in claimed intent fulfillment; no live Agent runtime is required.
- Intent claim expiry, bounded retry/backoff, attempt exhaustion, job cancellation, and authenticated failed-to-pending recovery obey the declared state machine.
- Replays return the original revision/result without moving the element or incrementing revision.
- Wrong user/workspace/project/canvas, non-succeeded job, mismatched media type/result, stale fence, unsupported effect kind, and malformed element/file data are rejected.
- Missing or mismatched `asset_id`, deterministic element/file ID collisions, and invalid explicit placement are rejected without changing the canvas.
- A valid receipt replays successfully after the element was moved, changed, or deleted and never recreates it.
- A malformed or cross-context receipt returns an integrity error.
- Expired-run recovery and resume racing under locks produce one current attempt and one valid terminal/run state.

### Regression verification

- Existing web and server suites pass.
- Shared contracts and TypeScript checks pass.
- Database migrations and pgTAP suites pass from a clean database and an upgraded database.
- Production web/server builds pass.
- A browser integration test reproduces the original sequence: idle canvas, Agent image generation, attachment, canvas sync, terminal run, and immediate ability to send the next message.

## Acceptance Criteria

- An idle open canvas does not increment its revision or upload thumbnails.
- A generated image or video is either durably attached exactly once, visibly pending in durable background work, or visibly reported as generated-but-not-attached with a working authenticated retry.
- Concurrent unsaved user edits are preserved when the generated element arrives.
- Every Agent tool response that reports `attached` has a durable element, matching receipt, outbox event, completed Agent effect, and returned revision from one transaction. Late intent fulfillment and user recovery commit the durable canvas effects plus intent/recovery audit without mutating a terminal Agent effect.
- No run remains `running` beyond its valid lease plus recovery grace period.
- Healthy long-running tools are not terminated by model inactivity handling.
- Logs and metrics identify the exact failed boundary without exposing sensitive payloads.
