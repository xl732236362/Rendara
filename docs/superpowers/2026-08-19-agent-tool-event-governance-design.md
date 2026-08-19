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
2. one durable canvas notification per committed canvas revision;
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
- Publish exactly one terminal public event for every published tool start.
- Create one durable canvas notification for each committed revision and apply
  it idempotently at consumers.
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

The existing pre- and post-execution checks remain mandatory:

- persisted execution context matches run, attempt, user, workspace, project,
  and canvas;
- persisted and currently deployed policy both grant the capability;
- attempt and fencing token are active;
- resource-specific authorization succeeds;
- input and result limits are enforced.

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
adaptation. Common fields are `agentRunId`, `attemptId`,
`logicalToolCallId`, `toolName`, `inputDigest`, and `timestamp`. The start
payload may contain bounded input. The completed payload may contain bounded
output, summary, and artifacts. The failed payload contains only a stable error
code, sanitized message, and correlation ID.

Event conflict checks and `agent_effects` use one shared canonical JSON encoder
and SHA-256 input-digest function. Duplicate digest implementations are removed
so semantically identical input cannot be classified differently at the event
and persistence boundaries.

The middleware sequence is fixed. `handler(request)` below is LangChain's
framework handler; the registered tool callback is the business handler:

1. validate identity and bounded input;
2. publish `started`; publication failure prevents handler execution;
3. run authority checks and call `handler(request)` at most once;
4. run postconditions;
5. if the supplied handler returns `ToolMessage` with `status: "error"`, verify
   its identity and structured error metadata, publish `failed`, and return that
   message unchanged so the model may correct the call;
6. otherwise publish `completed` and return the unchanged handler result;
7. if LangChain raises `ToolInvocationError` for invalid model arguments,
   publish `failed` and return a sanitized error `ToolMessage` with the same
   logical call ID so the model may correct its arguments;
8. recoverable business failures use the explicit error-result contract below;
   the middleware does not infer recoverability from error text;
9. if an authority check, control-flow cancellation, infrastructure operation,
   or unknown handler error throws after `started`, publish `failed` and
   rethrow the original error. If failure publication also fails, retain the
   original error as primary and attach the publication error as a sanitized
   secondary cause;
10. if `completed` publication fails after a successful handler, propagate a
   typed middleware publication error to the Agent runtime. The handler is
   never called again to recreate an event.

Except for the explicit invalid-argument conversion above, middleware errors
must bubble out of ToolNode. Agent construction must not set
`handleToolErrors: true`, which would convert governance and infrastructure
failures into model input and allow execution to continue. A framework
integration test locks this behavior for the supported LangChain version.

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
| Database, queue, network, storage, or output-bound failure | Thrown infrastructure/governance error |

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

Schema-invalid model arguments may enter LangChain's framework handler once but
execute zero business handlers. An admitted call executes one business handler.
No path invokes either handler more than once for the same logical call.

## Public Event State Machine

The shared public protocol contains `tool.started`, `tool.completed`, and
`tool.failed`. Tool blocks contain `running`, `completed`, or `failed` status.
`tool.failed` carries a plain schema-validated error record.

The adapter owns a per-run state machine keyed by `logicalToolCallId`:

```text
unseen -> started -> completed
                 -> failed
```

Rules:

1. only validated `loomic.tool.*` events enter this state machine;
2. a repeated, out-of-order, or conflicting canonical event is a protocol
   error and fails the run; it is not silently repaired;
3. reusing an ID with a different tool name or input digest is a protocol
   error;
4. when a stream fails or is canceled, the adapter emits one `tool.failed` for
   every still-open call before requesting run finalization;
5. a normal stream ending with an open tool call is a protocol error and the
   run is finalized as failed;
6. WebSocket replay and the web reducer idempotently upsert by
   `(agentRunId, logicalToolCallId)` because replay is intentionally
   at-least-once; this does not relax the canonical adapter rules;
7. server-side assistant message accumulation uses the same reducer as the web
   client so persisted blocks cannot remain `running` after a terminal run.

There is no legacy `on_tool_*` adapter, runnable-ID fallback, dual-read path,
or synthesized start event after the switch.

## Canvas Synchronization Ownership

Tool lifecycle events never emit `canvas.sync`. A committed canvas-write
transaction writes one `canvas.updated` domain event to `domain_outbox`; a
partial unique constraint on `(aggregate_id, aggregate_version)` where
`aggregate_type = 'canvas'` prevents a second logical event for the same
revision, regardless of event type. The domain event publisher is the only
component that adapts it to `canvas.sync`.

Every canvas revision notification uses the fixed outbox event type
`canvas.updated`. The mutation cause, such as direct manipulation or generated
asset attachment, is a bounded payload field rather than a second event type.
Canvas commit APIs no longer accept a caller-selected revision event type.
Before the partial unique constraint is installed, the cutover migration audits
existing canvas aggregate/revision pairs. Any duplicate aborts for explicit
operator resolution; the migration does not select an event by timestamp or
type.

`canvas.sync` is a canvas-domain WebSocket event, not an Agent run event. Its
public fields are `eventId`, `canvasId`, `revision`, and `timestamp`; it has no
fabricated `runId`. Canvas-level consumers do not filter it by Agent run. The
outbox is an at-least-once transport, so the server replay buffer and web canvas
reducer deduplicate by `eventId`. A redelivery may cross the wire but cannot
cause a second observable refresh in the mounted client.

Direct `connectionManager.pushToCanvas(...canvas.sync...)` calls in Agent tool
or job completion paths and the stream adapter's completion-based
`canvas.sync` are removed. Effect replay returns the recorded result without
committing another canvas revision or outbox event.

Read-only tools never emit `canvas.sync`. A failed canvas operation emits no
outbox event. This makes synchronization follow committed state rather than
the arrival of a tool callback.

## Atomic Run Finalization

`agent_runs.current_attempt_id` identifies the only attempt allowed to claim a
lease, commit an effect, mutate a canvas, resume, or finalize that run. The
schema enforces same-run ownership with a composite foreign key from
`(agent_runs.id, agent_runs.current_attempt_id)` to
`agent_run_attempts(run_id, attempt_id)`. The referenced pair is unique and the
foreign key is deferrable so acceptance can insert the run and its first attempt
in one transaction while keeping `current_attempt_id` non-null at commit.

Acceptance atomically creates both rows and sets `current_attempt_id`. Resume
locks the run and its current attempt, verifies that the run is active and the
attempt is eligible for recovery, terminates only that attempt as failed,
creates the replacement attempt, and advances `current_attempt_id` in the same
transaction. Previous attempts are immutable execution history. Every
attempt-scoped RPC validates both the supplied attempt ID and the run's current
pointer in addition to the fencing token.

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
| both active | terminal A | commit A to both and return A |
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

Every exit after attempt claim routes through this service: completion,
failure, cancellation, timeout, adapter protocol failure, and unexpected
exception. Direct run-only updates and `cancel_agent_attempt` are removed from
runtime orchestration.

The runtime publishes `run.completed`, `run.failed`, or `run.canceled` only
after the RPC confirms that state. Finalization calls are safe to retry with
the same arguments, including when a commit response was lost. After bounded
retry exhaustion, the persisted state is explicitly unknown: it may still be
active or the RPC may have committed. The server sends a transport-level
`run_finalization_unconfirmed` error with a correlation ID and emits no
terminal `StreamEvent`. On the next persisted-run query or resume, the server
reads the aligned run/current-attempt state before deciding whether to return
its terminal state or resume an active attempt. The WebSocket boundary must not
replace the unconfirmed error with a fabricated `run.failed` event.

An authenticated, resource-authorized run-status query joins through
`current_attempt_id` and returns the aligned persisted run and current attempt
state for this decision. It exposes no lease owner, fencing token, database
diagnostic, or other internal field. This is the only new recovery API; no
background coordinator or tool-event persistence is introduced.

The web client stops consuming the ended transport, shows the run as awaiting
status confirmation, and immediately requests persisted state. It does not
mark the run or any open tool block completed or failed until the server returns
a confirmed terminal state or resumes the active attempt.

Assistant message persistence is a separate post-run concern. Its failure is
logged and cannot alter the committed run state.

## One-Time Data Repair

Before direct terminal writes are removed, a migration repairs existing state
once. It adds `current_attempt_id` as nullable during backfill, classifies each
run under a lock, and performs only unambiguous repairs:

1. a terminal run with exactly one active attempt selects that attempt, sets it
   to the run state, copies the run completion time, and clears its lease;
2. a run with no active attempt and exactly one terminal attempt whose state
   matches the run selects that matching attempt, leaving all other historical
   attempts unchanged;
3. an active run with exactly one total terminal attempt promotes that terminal
   state to the run; this covers an interrupted run-only finalization;
4. a terminal pre-attempt run with no attempt receives one migration-created
   terminal attempt with the same state and completion time;
5. any remaining zero-candidate or multi-candidate row aborts the migration for
   explicit operator resolution instead of choosing by timestamp or ID.

Any candidate missing required terminal timestamps or ownership data also
aborts. The migration does not fabricate metadata to make an ambiguous row fit.

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

1. add the shared `tool.failed` contract and reducers, migrate recoverable tool
   results to error `ToolMessage`, and add real LangChain integration tests;
2. install middleware in main and sub-agents, switch the adapter to
   `loomic.tool.*`, and remove all guarded wrappers and native tool adaptation
   in the same server change;
3. standardize revision events on `canvas.updated`, install canvas
   aggregate/revision uniqueness, make outbox publication the sole
   `canvas.sync` source, and remove direct/adapter emissions;
4. stop accepting new Agent runs and drain active runs before the schema
   cutover; no old server process may write terminal state after this point;
5. run the one-time state repair, enforce `current_attempt_id`, install atomic
   finalization, and deploy the server, shared contracts, and web together;
6. resume Agent acceptance and run authenticated browser acceptance.

Persisted historical messages are immutable data and require no migration.
They use the same structural fields and are not consulted for live lifecycle
identity.

## Testing Strategy

### Framework boundary

Run success, recoverable invalid arguments followed by correction, unknown
tool name, returned error `ToolMessage`, unknown handler failure, terminal
publication failure, and a delegated sub-agent tool through a real LangChain
`streamEvents({ version: "v2" })` stream. Assert:

- `request.toolCall.id` becomes the public `toolCallId`;
- the Node `dispatchCustomEvent` entry point emits `on_custom_event` without a
  fabricated config;
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
- every main and sub-agent tool is capability-mapped and guarded.

### Adapter and public reducers

Cover success, failure, cancellation, duplicate canonical events, out-of-order
events, conflicting identity, open calls at stream termination, WebSocket
replay, and persisted assistant accumulation. Assert canonical protocol errors
fail the run while replayed public events remain idempotent.

Cover `run_finalization_unconfirmed` separately. Assert the WebSocket boundary
emits no terminal run event, the client enters status-confirmation state, and a
subsequent persisted-state read either returns the committed terminal state or
resumes the still-active attempt.

### Canvas synchronization

For a read, failed write, successful write, effect replay, generated asset
attachment, and outbox redelivery, assert the number of logical `canvas.sync`
applications is respectively zero, zero, one, zero, one, and one. Also assert
that the canvas event contains the outbox `eventId` and revision, is not filtered
by Agent run, and repeated delivery is ignored by `eventId`. Assert every
revision row uses `canvas.updated`, and inserting any second canvas event type
for the same aggregate and revision violates the unique constraint.

### Persistence

Test the repair migration with zero, one, and multiple historical attempts,
including an unambiguous resume history and every abort condition. Test
concurrent resume/finalize, complete/cancel, complete/fail, identical retry,
stale fencing, a non-current attempt, mismatched current rows, and an
indeterminate first RPC response followed by retry. Assert the run and current
attempt agree, historical attempts remain unchanged, and the public terminal
event equals the returned state.

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

For each identified, bounded call whose `started` publication succeeds:

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

- every canvas revision creates exactly one `canvas.updated` outbox row and each
  mounted client applies its `canvas.sync` projection once by `eventId`;
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
- **Canvas refresh is emitted before commit.** Allow only outbox-owned refresh
  events created in the canvas transaction.
- **Finalization result is unknown.** Retry the idempotent RPC and emit no
  terminal event until persistence confirms the state.
- **Replay repeats public events.** Upsert public state by run and logical call
  ID while treating duplicate canonical middleware events as protocol errors.
