# Agent Tool Event Governance Design

Date: 2026-08-19
Status: Approved for implementation planning

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
  -> one DynamicStructuredTool lifecycle
    -> guard before execution
      -> business operation
    -> guard after execution
```

Each tool must expose a framework-independent definition containing its name,
description, schema, and business handler. Tool construction creates exactly
one LangChain tool whose function runs `guardToolCall()` around that handler.
The guard must not invoke another LangChain `StructuredTool`.

Calling protected LangChain internals such as `_call()` is prohibited. It
would avoid callbacks today but bind Loomic to an unstable framework API.

Capability resolution remains server-owned. The same pre- and post-execution
checks remain mandatory:

- persisted execution context matches run, attempt, user, workspace, project,
  and canvas;
- the persisted and current deployment policies both grant the capability;
- the attempt and fencing token are active;
- input and result limits are enforced;
- resource-specific authorization succeeds.

## Canonical Event Adaptation

The stream adapter will maintain a per-run state machine keyed by
`logicalToolCallId`:

```text
unseen -> started -> completed
                 -> failed
```

Rules:

1. The adapter extracts the logical tool-call ID from canonical tool-call
   metadata. `frameworkRunId` and parent runnable IDs are retained only as
   diagnostic fields.
2. A repeated `started` or terminal event for the same logical ID is ignored
   after a structured duplicate-event log is written.
3. A terminal event received without a prior `started` produces a synthesized
   `started` followed by the terminal event. This preserves reconnect and
   partial-stream tolerance.
4. Reusing a logical ID with a different tool name or input digest is a
   protocol conflict. The run fails safely instead of merging the calls.
5. `canvas.sync` is emitted only on the first successful completion of a
   `manipulate_canvas` logical call.
6. A missing logical ID is treated as an instrumentation defect. A bounded
   compatibility fallback may pair start/end by framework ID, but it must log
   the defect and must not manufacture time-based business identities.

The public `tool.started` and `tool.completed` contracts continue using the
existing `toolCallId` property during migration; its value becomes the logical
ID. An optional `frameworkRunId` may be added for diagnostics. This avoids a
coordinated breaking release across server and web.

## Attempt Finalization

Run and attempt terminal transitions will be coordinated by a single
application service, conceptually `finalizeAgentRun`:

```text
run.completed -> completed attempt
run.failed    -> failed attempt
run.canceled  -> canceled attempt
```

The operation validates `attemptId` and `fencingToken`, clears or invalidates
the lease, records `completed_at`, and updates the run terminal metadata. It is
idempotent for an identical terminal outcome. A conflicting second terminal
outcome is logged and rejected.

All runtime exits after attempt claim must pass through this finalizer,
including stream adapter failures, persistence failures, cancellation,
timeouts, and unexpected exceptions. Cleanup failure must be logged with the
run and attempt identities and must not replace the original client-facing
failure.

The preferred persistence boundary is one database RPC that updates the run
and attempt atomically. If a transitional two-step implementation is needed,
the attempt transition occurs first and a reconciliation query detects and
repairs mismatched terminal state; this transitional state must not be the
final architecture.

## Error Handling And Observability

Repository adapters must log Supabase RPC failures before mapping them. Logs
include only bounded structured fields:

- `agentRunId`, `attemptId`, `logicalToolCallId`;
- `frameworkRunId`, `parentFrameworkRunId`;
- tool name and lifecycle phase;
- duration, replay status, and input digest;
- Supabase `code`, `message`, `details`, and `hint` after sanitization.

Logs must not include access tokens, complete canvas content, raw image data,
or unrestricted tool inputs.

Client errors remain stable, sanitized application errors. An internal
correlation ID connects the client failure to the detailed server log. Error
objects sent over WebSocket must be plain schema-validated records so browser
console serialization does not collapse them to `{}`.

## Compatibility And Rollout

The change is delivered in four compatible steps:

1. Add canonical identity extraction and event-state tests while retaining the
   current public event property names.
2. Refactor tool definitions so only one LangChain tool instance owns each
   lifecycle. Preserve all existing guard assertions.
3. Add atomic run/attempt finalization and reconciliation diagnostics.
4. Add browser acceptance coverage, then remove the temporary framework-ID
   fallback after production telemetry shows no missing logical IDs.

No persisted chat migration is required. Existing messages keep historical
framework-derived IDs; new messages use logical IDs. IDs are message-local in
the current UI and do not need cross-message rewriting.

## Testing Strategy

### Tool boundary integration

Run a guarded tool through a real LangChain agent event stream. Assert:

- one `on_tool_start` and one `on_tool_end` are adapted publicly;
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
terminal transition leaves no active attempt.

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

- **Tool refactor changes schemas or outputs.** Keep contract fixtures for every
  registered tool and compare definitions before and after construction.
- **Provider metadata lacks a logical ID.** Instrument this explicitly and
  retain a bounded framework-ID fallback during rollout.
- **Finalization failure masks the original error.** Preserve the primary
  failure and log cleanup failure separately with correlation fields.
- **Reconnect replays old events.** Keep server and client idempotency keyed by
  logical ID; do not depend on event arrival order.
- **Framework upgrades change callback metadata.** Isolate extraction in one
  adapter with fixtures based on supported LangChain versions.
