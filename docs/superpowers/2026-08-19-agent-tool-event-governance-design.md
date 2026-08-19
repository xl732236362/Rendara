# Agent Tool Event Governance Design

Date: 2026-08-19
Status: Revised after architecture review; awaiting implementation-plan approval

## Context

Phase 3 introduced canvas-scoped capability checks by wrapping each registered
LangChain tool in another `DynamicStructuredTool`. The wrapper invokes the
original tool through its public `invoke()` entry point. Both the wrapper and
the original tool therefore emit `on_tool_start` and `on_tool_end` lifecycle
events for one model tool call.

The stream adapter currently treats each LangChain runnable `run_id` as a
business `toolCallId`. The outer and inner lifecycle events have different
runnable IDs, so the adapter forwards both. The UI consequently renders two
tool cards and `manipulate_canvas` emits two `canvas.sync` events. The Phase 3
effect ledger prevents a second durable mutation, but it does not prevent the
duplicate observable lifecycle.

The same investigation found a related lifecycle gap: terminal `agent_runs`
can retain `agent_run_attempts` in `running` state. Repository errors also lose
their original Supabase diagnostics before they reach structured logging.

## Goals

- Emit exactly one public tool lifecycle for one logical model tool call.
- Preserve Phase 3 capability, scope, lease, fencing, and effect protections.
- Use one stable logical tool-call identity across events, effect receipts,
  logs, reconnects, and persisted chat blocks.
- Emit at most one `canvas.sync` for a successfully completed logical canvas
  mutation.
- Give every accepted attempt a terminal state when its run terminates.
- Retain actionable database diagnostics in server logs without exposing
  sensitive values to clients.
- Add integration coverage across the real LangChain event boundary.

## Non-goals

- Changing the Agent prompt or model tool-selection policy.
- Replacing LangChain or LangGraph.
- Removing the durable `agent_effects` ledger.
- Deduplicating calls by tool name or argument equality.
- Redesigning the chat UI beyond consuming canonical tool events.

## Identity Model

The implementation must distinguish three identities:

| Identity | Meaning | Consumers |
| --- | --- | --- |
| `agentRunId` | One user-request Agent execution | Runtime, WebSocket, persistence |
| `logicalToolCallId` | One tool call produced by the model | Events, effects, UI, logs |
| `frameworkRunId` | One LangChain runnable execution | Tracing and diagnostics only |

`logicalToolCallId` is the canonical public identity. A LangChain runnable ID
must never be used as a substitute when the logical ID is available.

## Tool Boundary Architecture

### Current flow

```text
Agent
  -> guarded DynamicStructuredTool lifecycle
    -> registeredTool.invoke()
      -> original tool lifecycle
        -> business operation
```

### Target flow

```text
Agent
  -> LangChain ToolNode
    -> Loomic wrapToolCall middleware
      -> guard before execution
      -> handler(request) invokes the registered tool once
      -> guard after execution
```

Loomic will use LangChain's public `createMiddleware({ wrapToolCall })`
extension point for capability, scope, lease, fencing, input/output bounds, and
resource authorization. The middleware receives `request.toolCall.id`,
`request.toolCall.name`, the registered tool, agent state, and runtime context.
It invokes the supplied `handler(request)` exactly once after the precondition
checks and performs the postcondition checks on the result.

Existing registered tool definitions, schemas, config handling, return values,
and artifact behavior remain unchanged. `guardStructuredTool` and the outer
`DynamicStructuredTool` wrappers are removed after all protected tools are
covered by the middleware. Tool construction must fail closed if a classified
tool has no capability mapping.

Calling protected LangChain internals such as `_call()` is prohibited. It
would avoid callbacks today but bind Loomic to an unstable framework API. The
middleware must also never invoke `request.tool.invoke()` directly, because
that would recreate the nested lifecycle; only the supplied handler owns tool
execution.

Capability resolution remains server-owned. The same pre- and post-execution
checks remain mandatory:

- persisted execution context matches run, attempt, user, workspace, project,
  and canvas;
- the persisted and current deployment policies both grant the capability;
- the attempt and fencing token are active;
- input and result limits are enforced;
- resource-specific authorization succeeds.

## Canonical Event Publication And Adaptation

LangChain tracing events are not a reliable source of business tool identity.
In the supported framework version, `handleToolStart` receives a tool-call ID,
but the v2 `streamEvents()` conversion does not expose that ID as a stable
field on `on_tool_start` or `on_tool_end`. Loomic must therefore publish its
own canonical events at the middleware boundary rather than infer identity
from tracing metadata.

The `wrapToolCall` middleware publishes schema-validated custom events with
LangChain's public `dispatchCustomEvent` API:

```text
loomic.tool.started
loomic.tool.completed
loomic.tool.failed
```

Every payload contains `agentRunId`, `attemptId`, `logicalToolCallId` from
`request.toolCall.id`, tool name, timestamp, and bounded input or output data.
The middleware emits `started` before calling the handler and exactly one
terminal event after the handler returns or throws. `dispatchCustomEvent` must
receive the active runnable configuration so the event remains attached to the
current run. Its propagation through the current
`streamEvents({ version: "v2" })` path must be proven by a framework integration
test before the old tool-event adaptation is removed.

Standard `on_tool_start` and `on_tool_end` remain available for tracing only.
The stream adapter must not translate them into public Loomic tool events.

The stream adapter will maintain a per-run state machine keyed by
`logicalToolCallId`:

```text
unseen -> started -> completed
                 -> failed
```

Rules:

1. The adapter accepts only validated `loomic.tool.*` events for public tool
   lifecycle output. The logical ID comes from the middleware payload, not a
   tracing runnable ID.
2. A repeated `started` or terminal event for the same logical ID is ignored
   after a structured duplicate-event log is written.
3. A terminal event received without a prior `started` produces a synthesized
   `started` followed by the terminal event. This preserves reconnect and
   partial-stream tolerance.
4. Reusing a logical ID with a different tool name or input digest is a
   protocol conflict. The run fails safely instead of merging the calls.
5. `canvas.sync` is emitted only on the first successful completion of a
   `manipulate_canvas` logical call.
6. A missing or malformed logical ID is a protocol violation. Side-effecting
   tools fail closed before handler execution. Read-only tool failures are also
   surfaced rather than assigned a framework or time-based fallback identity.
7. Custom-event publication failure fails closed before a side-effecting
   handler starts. Failure to publish a terminal event after a committed effect
   is recorded with a correlation ID and recovered from the durable effect
   record; the tool must not be executed again merely to recreate an event.

The public `tool.started` and `tool.completed` contracts continue using the
existing `toolCallId` property; its value becomes the logical ID. Tracing
`frameworkRunId` stays in server logs and is not required by the web contract.
This avoids a coordinated breaking release across server and web.

## Attempt Finalization

Run and attempt terminal transitions will be coordinated by a single
application service, conceptually `finalizeAgentRun`:

```text
run.completed -> completed attempt
run.failed    -> failed attempt
run.canceled  -> canceled attempt
```

The operation validates `attemptId` and `fencingToken`, clears the lease,
records `completed_at`, and updates the run terminal metadata. It uses an
atomic compare-and-set transition from `accepted|running` to one terminal
state. The first committed terminal state wins.

The database RPC always returns the canonical persisted terminal state:

| Current state | Requested state | Result |
| --- | --- | --- |
| `accepted|running` | any terminal state | Commit request and return it |
| same terminal state | same terminal state | Idempotently return existing state |
| terminal state A | different terminal state B | Keep and return A; log the race |

The runtime publishes a terminal WebSocket event only after finalization
returns. If cancellation and natural completion race, the event sent to the
client reflects the canonical state returned by the RPC, not the caller's
requested state. A finalization persistence failure produces a sanitized
runtime failure while retaining the original failure as its cause; it must not
guess or broadcast an uncommitted terminal state.

All runtime exits after attempt claim must pass through this finalizer,
including stream adapter failures, persistence failures, cancellation,
timeouts, and unexpected exceptions. Cleanup failure must be logged with the
run and attempt identities and must not replace the original client-facing
failure.

The persistence boundary is one database RPC that updates the run and attempt
atomically. A transitional two-step implementation is not permitted because it
would preserve the exact split-brain state this design is intended to remove.
Assistant chat-message persistence remains a separate post-run concern: its
failure is logged and retried independently and cannot change an already
committed execution terminal state.

## Error Handling And Observability

Repository adapters must throw typed infrastructure errors that retain
sanitized Supabase `code`, `message`, `details`, `hint`, and `cause`. They do
not write operational logs themselves. Runtime, HTTP, and worker orchestration
boundaries log each failure once before mapping it to a stable client error.
Logs include only bounded structured fields:

- `agentRunId`, `attemptId`, `logicalToolCallId`;
- `frameworkRunId`, `parentFrameworkRunId`;
- tool name and lifecycle phase;
- duration, replay status, and input digest;
- typed infrastructure error fields after sanitization.

Logs must not include access tokens, complete canvas content, raw image data,
or unrestricted tool inputs.

Client errors remain stable, sanitized application errors. An internal
correlation ID connects the client failure to the detailed server log. Error
objects sent over WebSocket must be plain schema-validated records so browser
console serialization does not collapse them to `{}`.

## Compatibility And Rollout

The change is delivered in four compatible steps:

1. Prove `wrapToolCall` and custom events with a real framework integration
   test while retaining current public event property names.
2. Install the guarded middleware, switch public tool adaptation to
   `loomic.tool.*`, and remove nested `DynamicStructuredTool` wrappers.
3. Add atomic first-terminal-wins run/attempt finalization and mismatch
   diagnostics.
4. Add authenticated browser acceptance coverage and production counters for
   rejected malformed tool identities and suppressed duplicate events.

No persisted chat migration is required. Existing messages keep historical
framework-derived IDs; new messages use logical IDs. IDs are message-local in
the current UI and do not need cross-message rewriting.

## Testing Strategy

### Tool boundary integration

Run a guarded tool through a real LangChain agent event stream. Assert:

- `request.toolCall.id` survives as the public `toolCallId`;
- one canonical custom start and one canonical custom terminal event are
  adapted publicly;
- standard tracing events are not adapted as business tool events;
- the business handler executes once;
- pre- and post-execution authority checks both execute;
- tool input and output validation remain active.

### Stream adapter

Cover normal, duplicated, nested, replayed, out-of-order, and conflicting
events. Assert one public lifecycle per logical ID and at most one
`canvas.sync`.

### Persistence

Verify identical effect replay returns the recorded result, changed input for
the same logical ID is rejected, stale fencing is rejected, and each run
terminal transition leaves no active attempt. Add concurrent complete/cancel,
complete/fail, and repeated-finalize tests that assert the persisted state and
public terminal event agree.

### Web and reconnect

Verify live and resumed streams merge by logical ID, terminal events stop
spinners, and a reconnect cannot append a duplicate tool block.

### Browser acceptance

Using an authenticated canvas session, execute:

1. canvas inspection;
2. a schema-invalid mutation followed by a corrected mutation;
3. a successful mutation;
4. disconnect and reconnect during a tool call.

For each logical call, assert one card, one handler execution, one effect
receipt where applicable, one canvas synchronization at most, one resulting
element, and a terminal attempt.

## Acceptance Criteria

For every logical tool call:

```text
1 logical tool call
= 1 business handler execution
= 1 public started/terminal lifecycle
= 0 or 1 durable effect receipt
= at most 1 canvas.sync
```

Additionally:

- no terminal run retains an accepted or running attempt;
- no repository failure loses its original sanitized database diagnostics;
- existing capability, authorization, lease, fencing, and replay tests pass;
- lint, typecheck, server/web tests, build, database tests, and authenticated
  browser acceptance pass before completion.

## Risks And Mitigations

- **Middleware changes tool results or error behavior.** Keep contract fixtures
  for every registered tool and compare outputs before and after middleware.
- **Custom events do not propagate through a framework upgrade.** Pin the
  supported LangChain behavior with an integration test and fail the build on
  drift; never fall back to runnable IDs for business identity.
- **Finalization failure masks the original error.** Preserve the primary
  failure and log cleanup failure separately with correlation fields.
- **Reconnect replays old events.** Keep server and client idempotency keyed by
  logical ID; do not depend on event arrival order.
- **Middleware loses runnable context during custom-event dispatch.** Pass the
  active runnable configuration explicitly and pin context propagation with the
  framework integration test.
