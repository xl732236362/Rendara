# Agent Tool Event Governance Design

Date: 2026-08-19
Status: Architecture-reviewed; awaiting user approval for implementation planning

## Context

Phase 3 introduced canvas-scoped capability checks by wrapping each registered
LangChain tool in another `DynamicStructuredTool`. The wrapper invokes the
original tool through `invoke()`. Both instances therefore emit LangChain tool
lifecycle events for one model tool call.

The stream adapter currently treats each runnable `run_id` as a business
`toolCallId`. The outer and inner events have different runnable IDs, so both
are forwarded. The UI renders two cards and the adapter may request two canvas
refreshes even though the Phase 3 effect ledger prevents a second durable
mutation.

The same lifecycle path can terminate an `agent_run` while leaving its
`agent_run_attempt` active. Repository error mapping also discards useful,
sanitized Supabase diagnostics.

## Scope

This design governs three directly related execution invariants:

1. one public lifecycle per logical model tool call;
2. one durable canvas notification per committed canvas revision advance;
3. one atomic terminal state shared by a run and its current attempt.

It does not add a durable journal for transient tool-card animation. Tool
lifecycle events are retained only by the existing WebSocket replay buffer and
persisted assistant message. After a server-process loss, durable run state,
effect receipts, and canvas revisions remain authoritative; incomplete tool
animation is not reconstructed.

## Goals

- Execute each business tool handler at most once per logical call and exactly
  once after identity, input, and pre-execution checks admit the call.
- Preserve capability, scope, lease, fencing, resource authorization, input
  bounds, output bounds, and durable effect protections.
- Use the model-provided tool-call ID across events, effects, logs, replay, and
  persisted chat blocks.
- During a live server process, publish exactly one terminal public event for
  every published tool start.
- Create one durable canvas notification for each committed revision advance and
  apply it idempotently at consumers.
- Commit the run and current-attempt terminal state in one database transaction.
- Preserve actionable database diagnostics in server logs without exposing
  sensitive values to clients.

## Non-goals

- Changing the Agent prompt or model tool-selection policy.
- Replacing LangChain or LangGraph.
- Removing the durable `agent_effects` ledger.
- Deduplicating calls by tool name or argument equality.
- Persisting or replaying framework tracing events.
- Recovering transient tool-card animation across a server restart.
- Addressing unrelated canvas autosave request timeouts.

## Identity Model

| Identity | Meaning | Consumers |
| --- | --- | --- |
| `agentRunId` | One user-request Agent execution | Runtime, WebSocket, persistence |
| `logicalToolCallId` | One model-produced tool call | Events, effects, UI, logs |
| `frameworkRunId` | One LangChain runnable execution | Tracing and diagnostics only |

`logicalToolCallId` is `request.toolCall.id`. It is the only public tool-call
identity. A missing or malformed ID fails the call before handler execution.
Runnable IDs and generated timestamps are never substitutes.

A call without a usable logical ID or safely bounded payload is rejected before
`started` publication and is reported as a run-level protocol failure. Tool
lifecycle cardinality applies once those publication prerequisites succeed.

## Tool Boundary Architecture

### Current flow

```text
Agent
  -> guarded DynamicStructuredTool lifecycle
    -> registeredTool.invoke()
      -> original tool lifecycle
        -> business handler
```

### Target flow

```text
Agent ToolNode
  -> Loomic wrapToolCall middleware
    -> validate identity and bounded input
    -> publish canonical started event
    -> pre-execution authority checks
    -> handler(request) at most once
       -> business handler once when admitted
    -> post-execution authority and output checks
    -> publish one canonical terminal event
```

Loomic uses LangChain's public `createMiddleware({ wrapToolCall })` extension
point. The middleware calls only the supplied `handler(request)`. It must not
call `request.tool.invoke()`, another tool's `invoke()`, or protected methods
such as `_call()`.

The framework assumptions in this design are verified against installed
`langchain@1.2.36` and `@langchain/core@1.1.35` source and their public APIs.
These versions are the initial support boundary; dependency upgrades must pass
the real framework integration suite before release rather than enabling a
runtime compatibility path.

`guardStructuredTool` and all outer `DynamicStructuredTool` wrappers are
removed in the same server change that installs the middleware. Existing tool
definitions, schemas, configuration handling, returned `ToolMessage` or
`Command`, and artifacts remain owned by the registered tool and ToolNode.

A server-owned exhaustive map assigns every registered tool to its required
capability set. This includes generated delegation tools such as `task`. Agent
construction fails if a selected tool is absent from the map or any required
capability is not granted. An unregistered name produced by the model is never
dynamically resolved or executed; ToolNode may only return its standard invalid
tool `ToolMessage`. The same per-run governance middleware is passed to every
`createAgent` call, including sub-agents, so a delegated tool never bypasses
the guard.

LangChain ToolNode executes multiple calls from one model message with
`Promise.all`; one rejection can therefore end the stream while sibling calls
continue. Loomic preserves valid parallel tool calls, but does not let that
unstructured lifetime escape the run boundary. The per-run supervisor below
independently arbitrates each logical call. When one rejection ends the stream,
completed siblings retain their terminal state. Runtime closes new admissions,
attempts atomic run finalization, and then closes every still-open sibling as
failed. It publishes a run terminal only after persistence confirms that state.
`wrapToolCall` remains the sole tool execution boundary.

The existing pre- and post-execution checks remain mandatory:

- persisted execution context matches run, attempt, user, workspace, project,
  and canvas;
- persisted and currently deployed policy both grant the capability;
- attempt and fencing token are active;
- resource-specific authorization succeeds;
- input and result limits are enforced.

## Per-Run Execution Supervision

Each Agent run owns one in-memory execution supervisor containing its abort
controller, a run admission state (`open` or `closing`), a call state keyed by
logical tool-call ID (`starting`, `open`, `finishing`, or `terminal`), and a
bounded monotonic record of canonical lifecycle events. The supervisor is the
live-process source of truth for tool terminality. Middleware creates normal
records, the privileged close path creates only the specified abandonment
records, and the adapter validates and projects both through one schema. No
component reconstructs an event from tracing data.

Supervisor `start` and `finish` use a per-call compare-and-set transition plus a
serialized publication queue. Before calling `dispatchCustomEvent`, the queue
stages an immutable, schema-validated record with its sequence number. The
adapter may observe that record while LangChain's event-stream writer is still
backpressured; it validates the custom event against the staged record and
acknowledges the record without acquiring the publication queue lock. This
prevents the writer, adapter, and supervisor from deadlocking. The record becomes
publicly projected when the adapter returns the corresponding `StreamEvent` to
the runtime consumer.

`start` moves `starting` to `open` only after the start record is projected; the
business handler cannot begin earlier. `finish` reserves `finishing`, stages one
completed or failed record, and moves to `terminal` only after that record is
projected. Once the adapter acknowledges a record, projection is irrevocable
even if a different LangChain callback subsequently throws. If dispatch fails
before acknowledgement, runtime retains and directly drains the exact staged
record, fails the run, and never retries the handler. A failed start dispatch
therefore executes zero business handlers but still closes the staged lifecycle;
a failed terminal dispatch leaves the call reserved for that same terminal
record rather than inventing a different outcome.

The supervisor record is capped by explicit per-run tool-call and serialized-
byte limits. Exceeding either limit rejects the new call before staging
`started`, executes no handler, and fails the run. A duplicate, missing,
reordered, or payload-different custom event relative to the next staged record
is a protocol failure. Runtime drains unprojected records in sequence before a
public run terminal. This drain is a second transport for the same supervisor
record, not a legacy event read, tracing fallback, or synthesized lifecycle.
The record is discarded with the run and is not a restart-recovery journal.

LangChain callback fan-out uses `Promise.all`, so one callback may reject while
the event-stream callback later delivers the already drained record. The
adapter idempotently acknowledges that transport copy only when its internal
sequence and complete canonical payload exactly match the already projected
record; it emits no second public event. A second canonical record, an unknown
sequence, or a payload mismatch remains a protocol failure. This narrow
transport acknowledgement does not deduplicate business calls or relax the
public state machine.

On stream failure, cancellation, timeout, transport disposal, or an explicit
cancel request, runtime atomically changes the supervisor to `closing`, closes
new admissions and unreserved handler-owned terminal transitions, and aborts the
signal. A normal `completed` close is admitted only after the source stream ends
normally and every admitted call is terminal; it cannot race past an open call.
An already-reserved `finishing` transition keeps the outcome that won its
compare-and-set, while every other late handler result is rejected.

Runtime invokes atomic run finalization next so the persisted attempt is fenced
against further Agent-attempt effects before public failure closure. Already
accepted downstream jobs continue under their own fencing and idempotency. After
the RPC confirms the canonical run state, runtime drains any previously staged
records, then uses the supervisor's privileged closing transition to append one
`tool.failed` with the stable closing reason for each remaining `starting` or
`open` call. It drains those records and only then publishes the confirmed run
terminal event. The privileged transition does not call `dispatchCustomEvent`:
after LangChain iteration ends there may be no active AsyncLocalStorage callback
context or writable event stream. It writes through the same canonical
supervisor schema and ordered projection path.

A late handler result cannot publish `completed`: its mandatory post-execution
authority check observes the closed supervisor or inactive attempt, publishes
no second public terminal event, and throws. Fenced database operations and
idempotency keys remain authoritative for work already in flight.

If finalization remains unconfirmed, runtime still closes each abandoned tool
call through the same privileged transition, drains all canonical records, and
sends `run_finalization_unconfirmed`, but emits no terminal run event. Status
recovery follows the persisted-state protocol below. Tool closure describes the
abandoned in-process invocation and does not claim a persisted run terminal
state or roll back an already accepted durable effect. Any later canvas revision
from such an effect is communicated only by its authoritative outbox event.

Runtime waits a bounded interval for the registered middleware invocation to
settle after abort, records a structured timeout if it does not, and releases
transport resources. It never retries the handler, waits indefinitely, or
reports an unconfirmed terminal run. The supervisor is process-local lifecycle
coordination, not a durable journal; process-loss recovery continues to use the
persisted run, current attempt, effects, and canvas revisions.

## Canonical Tool Event Protocol

LangChain `on_tool_start`, `on_tool_end`, and `on_tool_error` remain tracing
signals only. They are never translated into Loomic public tool events.

The middleware publishes the following custom events with the Node entry point
of `@langchain/core/callbacks/dispatch`:

```text
loomic.tool.started
loomic.tool.completed
loomic.tool.failed
```

The middleware calls `dispatchCustomEvent(name, payload)` without fabricating a
`RunnableConfig`. The Node implementation obtains the active configuration
from LangChain's AsyncLocalStorage. Importing the `/web` entry point or casting
`request.runtime` to `RunnableConfig` is prohibited because `ToolCallRequest`
does not expose the callback configuration.

Custom payloads are parsed by a Loomic-owned Zod discriminated union before
adaptation. Common fields are the internal monotonic `sequence`, `agentRunId`,
`attemptId`, `logicalToolCallId`, `toolName`, `inputDigest`, and `timestamp`.
The start payload may contain bounded input. The completed payload may contain bounded
output, summary, and artifacts. The failed payload contains only a stable error
code, sanitized message, and correlation ID.

Event conflict checks and `agent_effects` use one shared canonical JSON encoder
and SHA-256 input-digest function. Duplicate digest implementations are removed
so semantically identical input cannot be classified differently at the event
and persistence boundaries.

The middleware sequence is fixed. `handler(request)` below is LangChain's
framework handler; the registered tool callback is the business handler:

1. validate identity, bounded input, and supervisor admission state;
2. register the call, stage `started`, and project it through the custom-event
   path; failure prevents handler execution and leaves the staged call for
   ordered runtime closure;
3. run authority checks and call `handler(request)` at most once;
4. run postconditions;
5. if the supplied handler returns `ToolMessage` with `status: "error"`, verify
   its identity and, for a registered tool, structured error metadata; finish
   the supervisor call as `failed` and return that message unchanged so the
   model may correct the call;
6. otherwise finish the supervisor call as `completed` and return the unchanged
   handler result;
7. if LangChain raises `ToolInvocationError` for invalid model arguments,
   finish the supervisor call as `failed` and return a sanitized error
   `ToolMessage` with the same logical call ID so the model may correct its
   arguments;
8. recoverable business failures use the explicit error-result contract below;
   the middleware does not infer recoverability from error text;
9. if an authority check, control-flow cancellation, infrastructure operation,
   or unknown handler error throws after `started`, atomically transition the
   supervisor call to `failed`, publish only when that transition wins, and
   rethrow the original error. If failure publication also fails, retain the
   original error as primary and attach the publication error as a sanitized
   secondary cause;
10. if terminal dispatch fails after a handler result, retain the already
    reserved terminal record and propagate a typed middleware publication error
    to the Agent runtime. Runtime projects that exact record; the handler is
    never called again to recreate an event.

Except for the explicit invalid-argument conversion above, middleware errors
must bubble out of ToolNode. Agent construction must not set
`handleToolErrors: true`, which would convert governance and infrastructure
failures into model input and allow execution to continue. A framework
integration test locks this behavior for the supported LangChain version.

When `request.tool` is absent, middleware recognizes the framework's invalid
tool control path before capability lookup. It still validates identity and
input bounds, publishes one lifecycle, and calls the supplied handler once;
that handler may only return ToolNode's error `ToolMessage`. Middleware assigns
the fixed `invalid_tool` code from this control path. It never inserts a dynamic
tool, treats the unknown name as capability-mapped, or executes a business
handler.

### Recoverable tool outcomes

A recoverable failure is a result the model can act on, such as invalid canvas
operations, a missing requested element, a retryable screenshot failure, or a
generation failure that can be retried with different input. Every such path
returns a LangChain `ToolMessage` with `status: "error"`,
`tool_call_id: request.toolCall.id`, the registered tool name, and bounded
schema-owned content. Its `artifact` contains a Loomic-owned discriminated error
record with stable code and bounded details, which the middleware uses for the
public failed payload without parsing model-facing content. A shared server
helper constructs this message from the required `ToolRuntime.toolCallId`; it
does not inspect a runnable ID or synthesize a fallback.

All existing error-shaped paths in `manipulate_canvas`, `inspect_canvas`,
`screenshot_canvas`, `get_brand_kit`, `generate_image`, and `generate_video`
are explicitly reclassified. Recoverable paths migrate from untagged JSON
strings or objects to the error message contract. A successful negative query,
such as `configured: false`, remains a successful result only when absence is a
valid domain answer. Missing execution context, failed authorization, an
inconsistent configured resource, and infrastructure faults are typed thrown
errors because the model cannot repair them.

| Current tool path | Required classification |
| --- | --- |
| `manipulate_canvas` invalid operations | Recoverable error `ToolMessage` |
| `inspect_canvas` missing requested element | Recoverable error `ToolMessage` |
| Retryable screenshot or generation rejection | Recoverable error `ToolMessage` |
| Generation still pending after a bounded poll | Successful pending result with job identity |
| Brand kit not configured | Successful `configured: false` result |
| Missing run/user/canvas/token context | Thrown execution-context invariant error |
| Access denial or configured resource missing | Thrown authorization/resource invariant error |
| Infrastructure or output-bound failure | Thrown infrastructure or governance error |

A confirmed generation submission that remains pending, succeeds, or reaches a
recoverable terminal rejection completes its `agent_effects` receipt with the
job identity and bounded outcome. Re-entry for the same logical call returns
that recorded outcome and never submits again. An infrastructure failure before
submission is confirmed may leave the reservation retryable only through the
same downstream idempotency key. Background job completion and the canvas
transaction outbox, not the tool lifecycle, own any later asset attachment.

Business tools must not return a plain JSON string or object whose `error`,
`success`, or message text implicitly changes lifecycle state. Middleware and
adapters must not parse arbitrary tool content to guess failure. Returned error
`ToolMessage` values are published as `tool.failed` and passed back unchanged;
thrown governance, infrastructure, cancellation, and unknown errors publish
`tool.failed` and continue to the Agent runtime unchanged.

For a registered Loomic tool, the middleware requires the returned
`ToolMessage.tool_call_id` and name to match the request and requires the error
artifact to pass its Zod schema. A mismatch or missing artifact is a protocol
failure, not a recoverable result. Framework-produced invalid-tool and
invalid-argument errors receive fixed framework error codes based on the known
control path; their message text is never parsed for classification.

Registered Loomic tools may return `Command` only for successful control flow.
Any recoverable failure must be the direct error `ToolMessage` contract above.
Middleware validates a returned `Command` through its public shape, including a
matching non-error `ToolMessage` when LangChain requires one; an embedded error,
missing call identity, or malformed update is a protocol failure. Output bounds
cover the complete direct result, including `ToolMessage.content`, `artifact`,
and bounded `Command` updates, before any public projection.

Schema-invalid model arguments may enter LangChain's framework handler once but
execute zero business handlers. An admitted call executes one business handler.
No path invokes either handler more than once for the same logical call.

## Public Event State Machine

The shared public protocol contains `tool.started`, `tool.completed`, and
`tool.failed`. Tool blocks contain `running`, `completed`, or `failed` status.
`tool.failed` carries a plain schema-validated error record.

The supervisor arbitrates execution terminality, while the adapter owns the
corresponding public projection state machine keyed by `logicalToolCallId`:

```text
unseen -> started -> completed
                 -> failed
```

Rules:

1. only validated supervisor records enter this state machine; normal records
   arrive through matching `loomic.tool.*` events, while unprojected and
   privileged closing records use the ordered supervisor drain;
2. a repeated, out-of-order, or conflicting canonical record is a protocol
   error and fails the run; an exact late transport copy of an already projected
   sequence is acknowledged without a second public emission;
3. reusing an ID with a different tool name or input digest is a protocol
   error;
4. when a stream fails or is canceled, runtime closes the supervisor and awaits
   a confirmed finalization result or bounded retry exhaustion. It then drains
   already staged records, appends one `tool.failed` for each still-open call,
   and drains those records; only a confirmed database result permits a terminal
   run event;
5. a normal stream ending with an open tool call is a protocol error and the
   run is finalized as failed;
6. WebSocket replay and the web reducer idempotently upsert by
   `(agentRunId, logicalToolCallId)` because replay is intentionally
   at-least-once. The reducer is monotonic: an exact replay is a no-op, a replayed
   start cannot regress a terminal block, and a conflicting terminal payload is
   reported rather than overwriting the first terminal state. This does not
   relax the canonical adapter rules;
7. server-side assistant message accumulation uses the same reducer as the web
   client so persisted blocks cannot remain `running` after a terminal run.

There is no legacy `on_tool_*` adapter, runnable-ID fallback, dual-read path,
or synthesized start event after the switch.

## Canvas Synchronization Ownership

Tool lifecycle events never emit `canvas.sync`. A committed canvas-write
transaction causes the database to write one `canvas.updated` domain event to
`domain_outbox`. A row-level `AFTER UPDATE OF content, revision` trigger with a
`revision IS DISTINCT FROM old.revision` condition, rather than application code
in three RPCs, owns this insertion. A partial unique constraint on
`(aggregate_id, aggregate_version)` where `aggregate_type = 'canvas'` prevents a
second logical event for the same revision. The domain event publisher is the
only component that adapts it to `canvas.sync`.

The trigger derives aggregate ID, revision, and timestamp from the updated row,
uses the fixed event type `canvas.updated`, and writes an empty schema-owned
payload. Mutation cause and correlation remain in structured operation logs and
the job/effect ledgers; they are not duplicated into the synchronization event.
Canvas commit APIs accept neither an event type nor an event payload. Before the
partial unique constraint is installed, the cutover migration audits existing
canvas aggregate/revision pairs. Any duplicate aborts for explicit operator
resolution; the migration does not select an event by timestamp or type.

The canonical browser, background-job, and Agent canvas commit RPCs are the
only writers of `canvases.content` and `canvases.revision`. Direct table-level
update privileges are revoked from authenticated and service roles; unrelated
canvas metadata uses explicit column grants or its own RPC. Every commit RPC
locks the canvas, requires the caller's expected revision, and returns a typed
conflict instead of overwriting a newer revision. A row-level `BEFORE UPDATE OF
content, revision` trigger requires content and revision to change together and
requires the new revision to equal `old.revision + 1`. The `AFTER UPDATE` trigger
then inserts the event in that same transaction. Thus no client, worker, or
future server repository can omit an event, create an event for a no-op, advance
revision without changing content, or insert a second event for a committed
revision.

Direct `INSERT`, `UPDATE`, and `DELETE` privileges on `domain_outbox` are revoked
from the service role as well as browser roles. Domain mutation and canvas
trigger functions use dedicated security-definer owners; the dispatcher accesses
the table only through the existing claim, acknowledge, and fail RPCs. A
`BEFORE INSERT` validation trigger rejects every new canvas aggregate row whose
event type is not `canvas.updated`. Already published historical rows are not
rewritten and are never read by the new publisher. There is no general-purpose
application outbox writer.

`canvas.sync` is a canvas-domain WebSocket event, not an Agent run event. Its
public fields are `eventId`, `canvasId`, `revision`, and `timestamp`; it has no
fabricated `runId`. Canvas-level consumers do not filter it by Agent run. The
outbox is an at-least-once transport, so the server replay buffer and web canvas
reducer first deduplicate by `eventId`. The server index evicts IDs atomically
with its bounded replay entries, and the mounted-client index has the same fixed
retention bound rather than growing for the life of the process. The mounted
canvas initializes monotonic `highestObservedRevision` and `appliedRevision`
values from its authoritative snapshot. On mount or reconnect, it first
establishes the canvas subscription and buffers incoming events within a fixed
bound, then fetches the snapshot, drains the buffer through the same reducer,
and atomically switches to live consumption. Buffer overflow restarts this
initialization or reports an explicit synchronization error; it never drops an
event and declares the canvas current.

The reducer advances `highestObservedRevision` before scheduling or coalescing a
refresh and ignores any event whose revision is not greater. A coalesced refresh
retains the latest observed target and is satisfied only by a fetched snapshot at
or above that revision; a response older than either the target or the rendered
revision is discarded and retried with a bounded backoff. A newer event raises
the in-flight target. Exhaustion produces an explicit synchronization error with
a correlation ID rather than silently accepting stale state. Thus out-of-order
delivery or a delayed redelivery after ID eviction cannot cause a second logical
refresh or regress state.

The domain publisher validates the fixed canvas aggregate/event type and derives
`eventId`, `canvasId`, revision, and timestamp from trusted outbox columns. It
does not read the payload to route or construct a canvas notification.

Direct `connectionManager.pushToCanvas(...canvas.sync...)` calls in Agent tool
or job completion paths and the stream adapter's completion-based
`canvas.sync` are removed. Effect replay returns the recorded result without
committing another canvas revision or outbox event.

Read-only tools never emit `canvas.sync`. A failed canvas operation emits no
outbox event. This makes synchronization follow committed state rather than
the arrival of a tool callback.

## Atomic Run Finalization

`agent_runs.current_attempt_id` identifies the only Agent attempt allowed to
claim a lease, commit an Agent effect, request an Agent-time canvas mutation,
resume, or finalize that run. A background job accepted by a completed effect
continues under its own job lease and idempotency contract and uses the canonical
background-job canvas RPC. The schema enforces same-run ownership with a
composite foreign key from
`(agent_runs.id, agent_runs.current_attempt_id)` to
`agent_run_attempts(run_id, attempt_id)`. The referenced pair is unique and the
foreign key is `DEFERRABLE INITIALLY DEFERRED` so acceptance can insert the run
and its first attempt in one transaction while keeping `current_attempt_id`
non-null at commit.

A deferred constraint trigger on both tables enforces at transaction commit
that the run and current attempt have the same status and exactly the same
`completed_at`: both timestamps are null while active and equal non-null values
while terminal. Check constraints additionally require an accepted attempt to
have no lease, a running attempt to have a complete lease pair, and a terminal
attempt to have no lease and a non-null `completed_at`. No other attempt for the
run may be active. Existing direct
`INSERT`, `UPDATE`, and `DELETE` grants on `agent_runs`, `agent_run_attempts`,
and `agent_effects` are revoked from the service role. The application retains
read access and executes only the security-definer acceptance, claim, resume,
effect, and finalization RPCs. This makes the database invariant enforceable
rather than a convention in one repository class.

Every security-definer RPC has an empty trusted `search_path`, schema-qualifies
all referenced objects, and is owned by a dedicated non-login role with only the
specific table privileges each RPC requires. Default function execution is
revoked from `PUBLIC`, `anon`, and `authenticated`; only the intended application
role receives named `EXECUTE` grants. Each RPC validates supplied resource IDs
against the persisted run ownership and scope instead of trusting caller-supplied
user or workspace values. The functions never accept a relation, column,
operator, or SQL fragment from the caller.

Acceptance atomically creates both rows as `accepted` and sets
`current_attempt_id`; claim atomically moves both current rows to `running`.
Resume locks the run and current attempt and rejects a live unexpired lease. It
may replace only an `accepted` attempt or a `running` attempt whose lease has
expired: it terminates that attempt as failed, creates a new accepted attempt,
sets the run back to `accepted`, and advances `current_attempt_id` in the same
transaction. Previous attempts are immutable execution history. Every
attempt-scoped RPC validates both the supplied attempt ID and the run's current
pointer in addition to the fencing token.

All execution RPCs acquire rows in the same order: run, current attempt, then
effect or canvas rows in ascending primary-key order when more than one is
required. They perform no network work inside the transaction. This keeps lock
duration bounded and prevents claim, resume, effect, canvas, and finalization
paths from introducing opposing lock orders.

One application service, `finalizeAgentRun`, is the only path from an active
run to a terminal run. It calls one database RPC with `runId`, `attemptId`,
`fencingToken`, requested terminal state, completion time, and sanitized
terminal metadata.

The RPC locks the run, reads and locks `current_attempt_id` in a deterministic
order, and rejects a supplied attempt that is not current. It atomically updates
the run and current attempt, clears the lease, and records `completed_at`. An
active-to-terminal transition requires the exact fencing token. Once those two
rows are terminal, an identical retry with that token returns the canonical
state. The token is not advanced during finalization because terminal status
already rejects every stale effect or lease operation.

After the migration described below, only these run/current-attempt states are
valid:

| Persisted run/current-attempt state | Request | RPC result |
| --- | --- | --- |
| both active in the same state | terminal A | commit A to both and return A |
| both terminal A | terminal A | return A idempotently |
| both terminal A | terminal B | keep A and return A |
| any mismatched pair | any | fail with `agent_terminal_invariant_violation` |

A terminal run has a terminal current attempt with the same state and no active
attempt. Historical attempts may have different terminal states; for example,
a failed attempt followed by a completed resumed attempt is valid and must not
be rewritten during finalization.

The first transaction that commits a terminal state wins. A later cancel,
complete, or fail request broadcasts the state returned by the RPC, never its
requested state. Terminal metadata is written only by the first transition;
later requests never append failure data to a completed run or otherwise alter
the winning record.

Within one live runtime, the supervisor's `open -> closing` compare-and-set
selects the single local close owner. A completion request may win only after its
normal-stream and zero-open-call preconditions hold. Other local exit paths join
that close and reuse the database result; they do not independently publish a
run terminal. The database transaction remains authoritative across processes
and for external cancel/finalize races, where repeated public delivery is
idempotent by run ID and terminal state.

Every exit after run acceptance routes through this service, including a failure
before lease claim, completion, cancellation, timeout, adapter protocol failure,
and unexpected exception. An accepted attempt uses its persisted current fencing
token; a claimed attempt uses the token returned by claim. Direct run-only
updates and `cancel_agent_attempt` are removed from runtime orchestration.

The runtime publishes `run.completed`, `run.failed`, or `run.canceled` only
after the RPC confirms that state. Finalization calls are safe to retry with
the same arguments, including when a commit response was lost. After bounded
retry exhaustion, the persisted state is explicitly unknown: it may still be
active or the RPC may have committed. The server sends a transport-level
`run_finalization_unconfirmed` error with a correlation ID and emits no
terminal `StreamEvent`. On the next persisted-run query or resume, the server
reads the aligned run/current-attempt state before deciding whether to return
its terminal state, permit resume of an accepted or expired attempt, or require
the client to wait for a still-live lease. The WebSocket boundary must not
replace the unconfirmed error with a fabricated `run.failed` event.

An authenticated run-status query uses one authorization path for every run: it
joins the run's session to its canvas, project, workspace, and current workspace
membership. It joins through `current_attempt_id` and returns the aligned
persisted run and current-attempt state for this decision. It exposes no lease
owner, fencing token, database diagnostic, or other internal field. For a
running unexpired attempt it returns an `active_wait` decision with a bounded
server-computed `retryAfterMs`, not the raw lease. The client repeats the same
status query until the run is terminal or the attempt becomes resumable. This is
the only new recovery API; no background coordinator or tool-event persistence
is introduced.

The web client stops consuming the ended transport, preserves any supervisor-
confirmed tool terminal events, shows the run as awaiting status confirmation,
and immediately requests persisted state. It does not infer a run terminal state
from tool closure. It follows `active_wait` using the returned delay and changes
the run status only after the server returns a confirmed terminal state or
authorizes resume.

Assistant message persistence is a separate post-run concern. Its failure is
logged and cannot alter the committed run state.

## One-Time Data Repair

Before direct terminal writes are removed, a migration repairs existing state
once. It adds `current_attempt_id` as nullable during backfill, classifies each
run under a lock, and performs only unambiguous repairs:

1. an active run with exactly one active attempt selects that attempt and aligns
   the run to the attempt's `accepted` or `running` state; attempt state is
   authoritative because it records whether a lease was actually claimed, and
   the run's stale `completed_at` is cleared;
2. a terminal run with exactly one active attempt selects that attempt, sets it
   to the run state, copies the run completion time, and clears its lease;
3. a terminal run with no active attempt and exactly one terminal attempt whose
   state and `completed_at` exactly match the run selects that matching attempt,
   leaving all other historical attempts unchanged;
4. an active run with no active attempt and exactly one total terminal attempt
   promotes that terminal state and `completed_at` to the run; this covers an
   interrupted run-only finalization and never consumes a historical attempt
   while another attempt is active;
5. a terminal pre-attempt run with no attempt receives one migration-created
   terminal attempt with the same state and completion time;
6. an active pre-attempt run after the coordinated drain, or any remaining
   zero-candidate or multi-candidate row, aborts for explicit operator
   resolution instead of choosing by timestamp or ID.

Any active or resumable candidate with an invalid status/lease/timestamp shape
or incomplete Phase 3 execution context aborts. Complete context means
`user_id`, `client_request_id`, `request_digest`, `workspace_id`, `project_id`,
`canvas_id`, `capabilities`, `capability_policy_version`,
`skill_catalog_digest`, and `effective_skill_names` are all present and
structurally valid. The migration installs a state-shape check requiring that
context for every `accepted` or `running` run.

A terminal run in the exact pre-Phase3 shape may retain null Phase 3 context as
non-resumable history. The exact shape requires every field listed above to be
null and requires the run to have no attempt; a partially populated terminal row
or a context-free row with any attempt aborts. Only rule 5 creates its aligned
terminal attempt and current pointer. The row remains queryable through the same
authenticated session-to-resource ownership path as every other run but can
never be resumed, claimed, or used to authorize a new effect. The migration does
not fabricate ownership or policy metadata, and runtime contains no branch that
heals a legacy row.

The migration then installs the non-null, unique, and deferrable foreign-key
constraints and asserts the run/current-attempt invariant plus the existing
one-active-attempt invariant. Historical terminal attempts are preserved and
may differ from the run. Runtime code contains no legacy healing branch; any
later mismatch is an invariant failure.

## Error Handling And Observability

Repository adapters throw typed infrastructure errors that retain sanitized
Supabase `code`, `message`, `details`, `hint`, and `cause`. Repositories do not
write operational logs. Runtime, HTTP, worker, or WebSocket orchestration logs
each failure once before mapping it to a stable client error.

`tool.failed` and database-confirmed `run.failed` are protocol-level terminal
outcomes. The web reducer renders them and does not call `console.error` merely
because they were received. Browser error telemetry is reserved for malformed
contracts, protocol conflicts, reducer invariants, and transport failures, and
records only the bounded public error and correlation ID. This prevents an
expected run failure from appearing as a framework console exception while
preserving actionable diagnostics for an actual client defect.

Bounded structured logs include:

- `agentRunId`, `attemptId`, `logicalToolCallId`;
- framework run IDs only for tracing;
- tool name, lifecycle phase, duration, replay status, and input digest;
- sanitized infrastructure fields and correlation ID.

Logs exclude tokens, complete canvas content, raw media, unrestricted tool
input, and unrestricted tool output. Every public error is a plain
schema-validated record so browser serialization cannot collapse it to `{}`.

## Delivery Order

This is a coordinated replacement, not a compatibility rollout:

1. build and verify one coordinated release artifact containing the shared
   `tool.failed` contract and reducers, recoverable error `ToolMessage` results,
   supervisor and `wrapToolCall`, custom-event adapter, fixed `canvas.updated`
   contract, canonical RPC repositories, and all integration tests; none of
   these changes is activated separately;
2. enter a bounded maintenance window: stop new Agent runs and canvas writes,
   pause canvas-writing background workers, drain live Agent executions and
   in-flight canvas commits, then drain the old domain outbox publisher;
3. assert there is no live Agent execution, unexpired attempt lease,
   canvas-writing job, undispatched legacy canvas event, or duplicate canvas
   aggregate/revision pair. Residual accepted/running database rows are handled
   only by the locked repair rules above; any other failed assertion aborts the
   cutover for operator resolution without rewriting history or guessing
   ownership;
4. with old writers stopped, run the one-time Agent state repair, install
   `current_attempt_id`, execution state-shape constraints, atomic execution
   RPCs and revoked direct grants, then install canvas aggregate/revision
   uniqueness, canonical commit RPCs, paired-change and outbox triggers, canvas
   event validation, and revoked direct canvas/outbox grants;
5. deploy the server, worker, shared contracts, and web release together. The
   server accepts only the new protocol version; stale browser clients receive a
   reload-required response rather than a compatibility adapter;
6. resume the outbox publisher and background workers, verify their health, then
   resume canvas writes and Agent acceptance and run authenticated browser
   acceptance.

Persisted historical messages are immutable data and require no migration.
They use the same structural fields and are not consulted for live lifecycle
identity.

## Testing Strategy

### Framework boundary

Run success, recoverable invalid arguments followed by correction, unknown
tool name, returned error `ToolMessage`, unknown handler failure, terminal
publication failure, parallel calls where one rejects, cancellation during a
blocked handler, and a delegated sub-agent tool through a real LangChain
`streamEvents({ version: "v2" })` stream. Assert:

- `request.toolCall.id` becomes the public `toolCallId`;
- the Node `dispatchCustomEvent` entry point emits `on_custom_event` without a
  fabricated config;
- an inner sub-agent invocation inherits the outer `streamEvents` callback
  context, and its canonical events reach that outer stream through the shared
  per-run supervisor without an explicit fabricated config;
- one business handler invocation produces one public start and terminal;
- invalid arguments produce `tool.failed`, return one error `ToolMessage`, and
  allow a corrected logical call without invoking the invalid handler;
- unknown tools execute no dynamic implementation, and error `ToolMessage`
  results produce `tool.failed` without ending the Agent run;
- contract-test every current recoverable branch in each real registered tool;
  assert `status: "error"`, exact tool-call identity and name, a valid error
  artifact, bounded content, one failed event, and no completed event;
- assert every nonrecoverable context, authorization, configured-resource, and
  infrastructure failure throws instead of returning error-shaped content;
- middleware failures bubble to the runtime;
- native tracing events produce no public tool events;
- parallel calls receive independent logical identities; when one rejects,
  already completed siblings remain completed and every open sibling receives
  one failed terminal without a late state reversal;
- two distinct main- or sub-agent calls that reuse one logical tool-call ID fail
  the second admission before its handler runs, even when tool name and input are
  identical; the runtime never merges calls or invents a replacement identity;
- if a sibling terminal was published but not consumed before stream failure,
  adapter closure projects the exact supervisor record once before failing open
  siblings;
- force the adapter to consume a custom event while its LangChain writer remains
  backpressured; staged-record validation and acknowledgement must complete
  without a publication-queue deadlock;
- if dispatch fails before acknowledgement, runtime drains the staged record and
  executes no business handler; if another callback throws after acknowledgement,
  the acknowledged transition remains canonical and is not projected twice;
- after a callback failure and direct drain, a late custom-event transport copy
  with the same sequence and payload is ignored, while a changed payload or new
  duplicate record fails the protocol;
- completion, cancellation, and terminal-publication failure race through one
  supervisor transition and produce exactly one public terminal event;
- after cancellation no queued or late business handler can be admitted, and a
  late result cannot publish completed;
- privileged stream-closure events are projected after finalization without
  calling `dispatchCustomEvent` outside LangChain's AsyncLocalStorage context;
- every main and sub-agent tool is capability-mapped and guarded.

### Adapter and public reducers

Cover success, failure, cancellation, duplicate canonical events, out-of-order
events, conflicting identity, open calls at stream termination, WebSocket
replay, and persisted assistant accumulation. Assert canonical protocol errors
fail the run while replayed public events remain idempotent. Assert valid
`tool.failed` and `run.failed` events update the UI without invoking browser
error telemetry, while malformed or conflicting events report one bounded
diagnostic with their correlation ID.

Cover `run_finalization_unconfirmed` separately. Assert the WebSocket boundary
emits no terminal run event, the client enters status-confirmation state, and a
subsequent persisted-state read returns the committed terminal state, permits an
eligible resume, or returns `active_wait` without preempting an unexpired lease.
Assert a normal completion cannot enter finalization while any supervisor call
is `starting`, `open`, or `finishing`, and concurrent local close paths publish
only the database-confirmed terminal state.

### Canvas synchronization

For a read, failed write, successful write, effect replay, generated asset
attachment, and outbox redelivery, assert the number of logical `canvas.sync`
applications is respectively zero, zero, one, zero, one, and one. Also assert
that the canvas event contains the outbox `eventId` and revision and is not
filtered by Agent run. For each browser, background-job, and Agent commit RPC,
assert one valid update causes the trigger to create exactly one
`canvas.updated` row and that the RPC exposes no event-type or event-payload
argument. Effect replay performs no update and creates no event.

Assert direct canvas content/revision mutation and direct `domain_outbox` DML are
denied. Test through the trigger owner that a content-only change, revision-only
change, or revision jump is rejected; a no-op creates no event; a new canvas
event type is rejected; and a second event for the same canvas revision violates
the partial unique constraint. Verify server and client event-ID indexes remain
within their configured retention bound. Initialize from a current snapshot,
then deliver duplicate and out-of-order revisions; the monotonic reducer must
coalesce forward refreshes, ignore revisions at or below
`highestObservedRevision`, and never apply an older fetched snapshot. Return a
snapshot below the in-flight target, then assert bounded retry reaches the target
or reports an explicit synchronization error without marking stale state as
applied. Race an event against initial mount and reconnect; subscription-first
buffering must preserve it, while buffer overflow must restart synchronization or
surface the explicit error instead of silently dropping the event.

### Persistence

Test the repair migration with zero, one, and multiple historical attempts,
including an unambiguous resume history and every abort condition. Test
pre-claim failure finalization, concurrent resume/finalize, complete/cancel,
complete/fail, identical retry, stale fencing, a non-current attempt, mismatched
current rows, and an indeterminate first RPC response followed by retry. Assert
the run and current attempt agree, historical attempts remain unchanged, and the
public terminal event equals the returned state. Include the exact regression
case of a failed historical attempt plus one active current attempt; migration
must select the active attempt and must not promote the historical failure.
Assert direct table
mutation is denied and a test-only mismatched transaction is rejected by the
deferred constraint. Verify every security-definer RPC has the fixed empty
`search_path`, non-login owner, schema-qualified references, least-privilege
`EXECUTE` grants, persisted resource authorization, and no dynamic SQL input
surface.
Verify active and resumable runs with incomplete Phase 3 context abort migration,
while a pre-Phase3 terminal run with missing new context remains queryable as
non-resumable history and cannot claim, resume, or authorize an effect. The same
session-to-resource membership query must authorize both historical and current
runs and deny a caller outside that resource chain.
Rehearse the coordinated migration from a production-shaped snapshot. Verify
each maintenance precondition aborts before schema mutation when live or leased
attempts, canvas-writing jobs, undispatched legacy canvas events, or duplicate
canvas aggregate/revision rows remain; verify unleased residual rows follow only
the stated repair matrix and the clean snapshot migrates atomically.

### Browser acceptance

Using an authenticated canvas session, execute:

1. canvas inspection;
2. a schema-invalid mutation followed by a corrected mutation;
3. a successful mutation;
4. disconnect and reconnect during a tool call;
5. a delegated generation tool when enabled.

Assert one card per logical call, correct completed or failed state, zero
business-handler executions for rejected input and one for an admitted call,
zero or one effect receipt, at most one logical canvas refresh, and an aligned
terminal run/current-attempt pair.

## Acceptance Criteria

For each identified, bounded call whose `started` publication succeeds while
the server process remains live:

```text
1 logical tool call
= 1 public started event
= 1 public completed or failed event

0 business-handler executions when rejected before admission
1 business-handler execution when admitted
never more than 1 framework-handler or business-handler execution

0 or 1 durable effect receipt
```

Additionally:

- cancellation, failure, and completion contend through one supervisor terminal
  transition per logical call, so no open call completes publicly after run
  closure;
- normal completion cannot finalize while a call is nonterminal, and abnormal
  closure fences persistence before appending failed records for open calls;
- every committed canvas revision advance creates exactly one `canvas.updated`
  outbox row and each mounted client applies its `canvas.sync` projection once
  through bounded event identity and monotonic revision handling;
- canvas content/revision and Agent execution state are writable only through
  their canonical RPCs; database triggers own canvas event creation while
  database constraints enforce both domains' state invariants;
- no terminal run has an active or differently terminated current attempt;
- historical attempts remain terminal history and may differ from the run;
- no live path consumes a runnable ID as a logical tool-call ID;
- no repository failure loses its sanitized database diagnostics;
- no runtime compatibility branch adapts old tool events or repairs old state;
- lint, typecheck, server/web tests, build, database tests, and authenticated
  browser acceptance pass before completion.

## Risks And Mitigations

- **LangChain changes custom-event or middleware behavior.** Pin the supported
  behavior with real integration tests and fail the build on drift.
- **Middleware changes a tool result.** Compare returned `ToolMessage`,
  `Command`, artifacts, and errors before and after middleware.
- **A middleware error is converted into model input.** Prohibit
  `handleToolErrors: true` and test that middleware errors reach the runtime.
- **ToolNode leaves sibling promises running after one rejection.** Close and
  abort every open supervisor call, fence persisted effects, and reject late
  terminal transitions.
- **A handler ignores cancellation.** Close admissions, fence the persisted
  attempt, bound the supervisor drain, and reject any late completion.
- **Canvas refresh is emitted before commit.** Allow only outbox-owned refresh
  events created in the canvas transaction.
- **Finalization result is unknown.** Retry the idempotent RPC and emit no
  terminal event until persistence confirms the state.
- **Replay repeats public events.** Upsert public state by run and logical call
  ID while treating duplicate canonical middleware events as protocol errors.
