# Agent Tool Event Governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one model tool call execute once, render one lifecycle card, and
cause at most one committed canvas refresh while run and attempt terminal state
remain aligned.

**Architecture:** Replace Phase 3's nested tool wrappers and tracing-derived
events with one LangChain `wrapToolCall` middleware and a per-run supervisor.
Canvas refreshes originate only from committed `canvas.updated` outbox rows,
and one mounted-canvas coordinator consumes them. Run and current-attempt
finalization moves into one database transaction.

**Tech Stack:** TypeScript, LangChain 1.2.36, LangGraph 1.2.5, Zod, Vitest,
Next.js 15, React 19, Supabase/PostgreSQL, pgTAP, Playwright

---

## File Structure

- `packages/shared/src/events.ts`: public stream protocol, including
  `tool.failed` and revision-bearing `canvas.sync`.
- `packages/shared/src/contracts.test.ts`: wire-protocol regression tests.
- `apps/server/src/agent/tool-lifecycle.ts`: canonical internal lifecycle
  schema, reducer, and logical-call identity checks.
- `apps/server/src/agent/tool-execution-supervisor.ts`: per-run call state,
  ordered staging, acknowledgement, and closing.
- `apps/server/src/agent/tool-governance-middleware.ts`: the sole LangChain
  `wrapToolCall` boundary.
- `apps/server/src/agent/tool-governance-middleware.test.ts`: real LangChain
  integration and handler cardinality tests.
- `apps/server/src/agent/agent-factory.ts`: installs the same middleware on
  main and delegated agents.
- `apps/server/src/agent/tools/tool-guard.ts`: retains reusable validation and
  authority checks but no longer constructs a tool wrapper.
- `apps/server/src/agent/tools/index.ts`: returns original registered tools.
- `apps/server/src/agent/stream-adapter.ts`: consumes only canonical Loomic
  custom tool events; tracing tool events stay diagnostic-only.
- `apps/server/src/agent/runtime.ts`: owns projection, replay reservation,
  supervisor closure, and database-confirmed run termination.
- `apps/server/src/features/agent-runs/agent-execution-repository.ts`: canonical
  acceptance, claim, resume, effect, status, and finalization RPC adapters.
- `apps/server/src/features/agent-runs/agent-run-service.ts`: retries the
  idempotent finalization RPC and returns confirmed or unconfirmed state.
- `apps/server/src/features/canvas/canvas-repository.ts`: calls only canonical
  canvas commit RPCs without caller-provided event fields.
- `apps/server/src/events/domain-event-publisher.ts`: maps the fixed
  `canvas.updated` outbox record to one revision-bearing `canvas.sync` event.
- `supabase/migrations/20260819000001_agent_tool_event_governance.sql`: one-time
  repair, invariants, canonical RPCs, canvas event triggers, indexes, and least
  privilege grants.
- `supabase/tests/agent_tool_event_governance.test.sql`: pgTAP coverage for
  state alignment, idempotency, permissions, and one outbox row per revision.
- `apps/web/src/lib/tool-event-reducer.ts`: pure idempotent public lifecycle
  reducer used by live and replay paths.
- `apps/web/src/hooks/use-chat-stream.ts`: applies expected failure events
  without browser error telemetry.
- `apps/web/src/hooks/use-mounted-canvas-sync.ts`: sole browser owner of
  `canvas.sync`, monotonic revisions, refresh coalescing, and draft conflicts.
- `apps/web/src/app/canvas/page.tsx`: mounts the coordinator and removes chat or
  polling refresh ownership.
- `apps/web/src/components/chat-sidebar.tsx`: renders Agent events but cannot
  refresh or mutate canvas state.
- `apps/web/src/components/canvas-editor.tsx`: exposes draft/save state and
  requires an explicit reset after a revision conflict.

### Task 1: Lock The Shared Public Protocol

**Files:**
- Modify: `packages/shared/src/events.ts`
- Modify: `packages/shared/src/contracts.ts`
- Modify: `packages/shared/src/contracts.test.ts`

- [ ] **Step 1: Write failing contract tests**

Add cases proving `tool.failed` has a plain bounded error record and
`canvas.sync` carries stable `eventId`, `canvasId`, and positive `revision`:

```ts
expect(streamEventSchema.parse({
  type: "tool.failed",
  runId: "run-1",
  toolCallId: "call-1",
  toolName: "inspect_canvas",
  error: { code: "invalid_arguments", message: "Check the arguments.", correlationId: "corr-1" },
  timestamp: now,
})).toMatchObject({ type: "tool.failed", toolCallId: "call-1" });

expect(streamEventSchema.parse({
  type: "canvas.sync",
  eventId: "event-1",
  canvasId: "canvas-1",
  revision: 2,
  timestamp: now,
})).toMatchObject({ eventId: "event-1", revision: 2 });
```

- [ ] **Step 2: Run the shared tests and confirm RED**

Run: `pnpm --filter @loomic/shared test`

Expected: FAIL because `tool.failed` is absent and `canvas.sync` does not yet
require the authoritative event identity and revision.

- [ ] **Step 3: Add the minimal schemas and exported types**

Define the new variants in the existing discriminated union:

```ts
const publicToolErrorSchema = z.object({
  code: z.string().min(1).max(64),
  message: z.string().min(1).max(512),
  correlationId: identifierSchema,
}).strict();

const toolFailedEventSchema = toolEventBaseSchema.extend({
  type: z.literal("tool.failed"),
  error: publicToolErrorSchema,
}).strict();

const canvasSyncEventSchema = z.object({
  type: z.literal("canvas.sync"),
  eventId: identifierSchema,
  canvasId: identifierSchema,
  revision: z.number().int().positive(),
  timestamp: timestampSchema,
}).strict();
```

- [ ] **Step 4: Run tests and typecheck GREEN**

Run: `pnpm --filter @loomic/shared test && pnpm --filter @loomic/shared typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the protocol**

```bash
git add packages/shared/src/events.ts packages/shared/src/contracts.ts packages/shared/src/contracts.test.ts
git commit -m "feat(agent): define canonical tool and canvas events"
```

### Task 2: Build The Canonical Lifecycle Reducer And Supervisor

**Files:**
- Create: `apps/server/src/agent/tool-lifecycle.ts`
- Create: `apps/server/src/agent/tool-execution-supervisor.ts`
- Create: `apps/server/src/agent/tool-execution-supervisor.test.ts`

- [ ] **Step 1: Write failing supervisor tests**

Cover one start and one terminal, exact replay acknowledgement, conflicting
duplicates, duplicate logical IDs, closing open calls, late completion, bounded
call count, and start-before-handler acknowledgement:

```ts
const supervisor = createToolExecutionSupervisor({
  runId: "run-1",
  attemptId: "attempt-1",
  maxCalls: 4,
  maxBytes: 64_000,
});
const started = supervisor.stageStart(call("call-1"));
expect(supervisor.state("call-1")).toBe("starting");
supervisor.acknowledge(started.sequence, started);
expect(supervisor.state("call-1")).toBe("open");
const terminal = supervisor.stageCompleted("call-1", { outputSummary: "ok" });
supervisor.acknowledge(terminal.sequence, terminal);
expect(supervisor.state("call-1")).toBe("terminal");
expect(() => supervisor.stageCompleted("call-1", {})).toThrow("tool_call_terminal");
```

- [ ] **Step 2: Run the test and confirm RED**

Run: `pnpm --filter @loomic/server test -- src/agent/tool-execution-supervisor.test.ts`

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement the pure reducer and bounded supervisor**

Use explicit states and immutable canonical records:

```ts
export type ToolCallState = "starting" | "open" | "finishing" | "terminal";

export interface CanonicalToolRecord {
  readonly sequence: number;
  readonly agentRunId: string;
  readonly attemptId: string;
  readonly logicalToolCallId: string;
  readonly toolName: string;
  readonly inputDigest: string;
  readonly timestamp: string;
  readonly type: "started" | "completed" | "failed";
  readonly payload: Readonly<Record<string, unknown>>;
}

export function reduceToolLifecycle(
  state: ReadonlyMap<string, ToolCallState>,
  record: CanonicalToolRecord,
): ReadonlyMap<string, ToolCallState> {
  const next = new Map(state);
  const current = next.get(record.logicalToolCallId);
  if (record.type === "started" && current === undefined) next.set(record.logicalToolCallId, "open");
  else if (record.type !== "started" && current === "open") next.set(record.logicalToolCallId, "terminal");
  else throw new Error("tool_lifecycle_protocol_conflict");
  return next;
}
```

The supervisor owns admission, sequence allocation, complete-payload equality,
bounded byte accounting, a serialized staging queue, acknowledgements, and a
single `open -> closing` transition. Do not add a broker or persistent journal.

- [ ] **Step 4: Run focused server tests GREEN**

Run: `pnpm --filter @loomic/server test -- src/agent/tool-execution-supervisor.test.ts`

Expected: PASS with each state transition asserted once.

- [ ] **Step 5: Commit the supervisor**

```bash
git add apps/server/src/agent/tool-lifecycle.ts apps/server/src/agent/tool-execution-supervisor.ts apps/server/src/agent/tool-execution-supervisor.test.ts
git commit -m "feat(agent): supervise logical tool lifecycles"
```

### Task 3: Replace Nested Tool Wrappers With One Middleware

**Files:**
- Create: `apps/server/src/agent/tool-governance-middleware.ts`
- Create: `apps/server/src/agent/tool-governance-middleware.test.ts`
- Modify: `apps/server/src/agent/agent-factory.ts`
- Modify: `apps/server/src/agent/agent-factory.test.ts`
- Modify: `apps/server/src/agent/tools/tool-guard.ts`
- Modify: `apps/server/src/agent/tools/tool-boundary.test.ts`
- Modify: `apps/server/src/agent/tools/index.ts`

- [ ] **Step 1: Write failing real-framework tests**

Create an Agent with the pinned LangChain packages and assert the model-provided
ID survives, the business handler runs once, custom start/terminal records each
occur once, invalid arguments return one error `ToolMessage`, and a thrown
boundary failure appears as `MiddlewareError` whose direct cause is branded:

```ts
expect(handler).toHaveBeenCalledTimes(1);
expect(records.map((record) => [record.type, record.logicalToolCallId])).toEqual([
  ["started", "model-call-1"],
  ["completed", "model-call-1"],
]);
expect(error).toBeInstanceOf(MiddlewareError);
expect(isLoomicToolBoundaryError((error as MiddlewareError).cause)).toBe(true);
expect(MiddlewareError.isInstance(error)).toBe(false);
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run: `pnpm --filter @loomic/server test -- src/agent/tool-governance-middleware.test.ts src/agent/agent-factory.test.ts src/agent/tools/tool-boundary.test.ts`

Expected: FAIL because Agent construction has no middleware and tools are still
wrapped in a second `DynamicStructuredTool`.

- [ ] **Step 3: Implement one `wrapToolCall` boundary**

Create the middleware with the public LangChain extension point:

```ts
export function createToolGovernanceMiddleware(deps: GovernanceDependencies) {
  return createMiddleware({
    name: "LoomicToolGovernance",
    wrapToolCall: async (request, handler) => {
      const id = requireLogicalToolCallId(request.toolCall.id);
      const call = await deps.supervisor.start({
        logicalToolCallId: id,
        toolName: request.toolCall.name,
        input: request.toolCall.args,
      });
      try {
        await deps.authorize(call);
        const result = await handler(request);
        await deps.authorize(call);
        await deps.supervisor.finishFromResult(call, result);
        return result;
      } catch (cause) {
        if (isGraphBubbleUp(cause)) throw cause;
        await deps.supervisor.fail(call, classifyBoundaryFailure(cause));
        throw new LoomicToolBoundaryError(call, cause);
      }
    },
  });
}
```

Call `dispatchCustomEvent` without a fabricated config. Keep the input/output
bounds and pre/post authority functions in `tool-guard.ts`, but delete
`guardStructuredTool`. `createMainAgentTools` must return original tool objects.
Pass the same middleware instance to every main and sub-agent `createAgent`
call, and reject a second application middleware defining `wrapToolCall`.

- [ ] **Step 4: Run focused tests GREEN**

Run: `pnpm --filter @loomic/server test -- src/agent/tool-governance-middleware.test.ts src/agent/agent-factory.test.ts src/agent/tools/tool-boundary.test.ts`

Expected: PASS, including one handler invocation and no nested wrapper.

- [ ] **Step 5: Commit the single tool boundary**

```bash
git add apps/server/src/agent/tool-governance-middleware.ts apps/server/src/agent/tool-governance-middleware.test.ts apps/server/src/agent/agent-factory.ts apps/server/src/agent/agent-factory.test.ts apps/server/src/agent/tools/tool-guard.ts apps/server/src/agent/tools/tool-boundary.test.ts apps/server/src/agent/tools/index.ts
git commit -m "fix(agent): enforce one governed tool boundary"
```

### Task 4: Project Only Canonical Tool Events

**Files:**
- Modify: `apps/server/src/agent/stream-adapter.ts`
- Create: `apps/server/src/agent/stream-adapter.test.ts`
- Modify: `apps/server/src/agent/runtime.ts`
- Modify: `apps/server/src/agent/runtime.application-wiring.test.ts`

- [ ] **Step 1: Write failing adapter and projection tests**

Feed outer and inner `on_tool_start/on_tool_end` tracing events plus one pair of
Loomic custom events. Assert only the custom pair becomes public, exact replay
is silent, changed replay fails, and replay append precedes acknowledgement:

```ts
expect(publicEvents.filter((event) => event.type.startsWith("tool."))).toEqual([
  expect.objectContaining({ type: "tool.started", toolCallId: "model-call-1" }),
  expect.objectContaining({ type: "tool.completed", toolCallId: "model-call-1" }),
]);
expect(order).toEqual(["prepare", "replay.append", "commit", "ack", "fanout"]);
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `pnpm --filter @loomic/server test -- src/agent/stream-adapter.test.ts src/agent/runtime.application-wiring.test.ts`

Expected: FAIL because tracing events still create public tool events and
`manipulate_canvas` completion still emits `canvas.sync`.

- [ ] **Step 3: Implement the single projector**

Parse only `on_custom_event` records named `loomic.tool.started`,
`loomic.tool.completed`, or `loomic.tool.failed`. The projector sequence is:

```ts
const prepared = preparePublicToolEvent(accumulator, record);
replay.reserve(record.logicalToolCallId);
replay.append(prepared.event);
accumulator = prepared.state;
supervisor.acknowledge(record.sequence, record);
connectionManager.pushToCanvas(canvasId, prepared.event);
```

Do not adapt `on_tool_start`, `on_tool_end`, or `on_tool_error`. Remove the
adapter-owned `canvas.sync`. On closure, drain the supervisor's exact staged
records before publishing a database-confirmed run terminal.

- [ ] **Step 4: Run focused tests GREEN**

Run: `pnpm --filter @loomic/server test -- src/agent/stream-adapter.test.ts src/agent/runtime.application-wiring.test.ts`

Expected: PASS with one public card lifecycle per logical call.

- [ ] **Step 5: Commit canonical projection**

```bash
git add apps/server/src/agent/stream-adapter.ts apps/server/src/agent/stream-adapter.test.ts apps/server/src/agent/runtime.ts apps/server/src/agent/runtime.application-wiring.test.ts
git commit -m "fix(agent): project canonical tool events once"
```

### Task 5: Add Atomic Agent Finalization

**Files:**
- Create: `supabase/migrations/20260819000001_agent_tool_event_governance.sql`
- Create: `supabase/tests/agent_tool_event_governance.test.sql`
- Modify: `apps/server/src/features/agent-runs/agent-execution-repository.ts`
- Modify: `apps/server/src/features/agent-runs/agent-execution-repository.test.ts`
- Modify: `apps/server/src/features/agent-runs/agent-run-service.ts`
- Modify: `apps/server/src/features/agent-runs/agent-run-service.test.ts`

- [ ] **Step 1: Write failing pgTAP and repository tests**

Cover `current_attempt_id`, same-run foreign keys, aligned status/timestamp,
complete-versus-cancel races, idempotent retry, stale fencing, old RPC removal,
and sanitized Supabase diagnostics:

```sql
select is(
  (select r.status = a.status and r.completed_at = a.completed_at
   from public.agent_runs r
   join public.agent_run_attempts a on a.attempt_id = r.current_attempt_id
   where r.id = :'run_id'),
  true,
  'run and current attempt finalize together'
);

select throws_ok(
  $$select public.finalize_agent_run(:'run_id', :'other_attempt', 1, 'failed', '{}'::jsonb)$$,
  'P0001', 'agent_attempt_not_current', 'a historical attempt cannot finalize the run'
);
```

- [ ] **Step 2: Run tests and confirm RED**

Run: `pnpm --filter @loomic/server test -- src/features/agent-runs/agent-execution-repository.test.ts src/features/agent-runs/agent-run-service.test.ts`

Run: `supabase test db`

Expected: the new assertions in
`supabase/tests/agent_tool_event_governance.test.sql` fail because the migration
has not added the required current-attempt and finalization invariants.

Expected: FAIL because current attempt identity and atomic finalization are not
yet enforced.

- [ ] **Step 3: Implement the migration and canonical RPC adapter**

The migration must:

```sql
alter table public.agent_runs add column current_attempt_id uuid;
alter table public.agent_run_attempts
  add constraint agent_run_attempts_run_attempt_unique unique (run_id, attempt_id);
alter table public.agent_runs
  add constraint agent_runs_current_attempt_fk
  foreign key (id, current_attempt_id)
  references public.agent_run_attempts (run_id, attempt_id)
  deferrable initially deferred;
alter table public.agent_effects
  add constraint agent_effects_run_attempt_fk
  foreign key (run_id, attempt_id)
  references public.agent_run_attempts (run_id, attempt_id);
```

Backfill only the six unambiguous cases in the approved design and abort all
ambiguous ownership/state rows. Add indexed foreign-key columns, deterministic
lock order, deferred invariant checks, forced RLS, fixed non-login
operation-family owners, empty `search_path`, and explicit grants. Revoke and
drop superseded RPC signatures; do not add fallback overloads.

Expose one repository operation:

```ts
finalizeRun(input: {
  runId: string;
  attemptId: string;
  fencingToken: number;
  status: "completed" | "failed" | "canceled";
  metadata: Readonly<Record<string, unknown>>;
}): Promise<{ status: "completed" | "failed" | "canceled"; completedAt: Date }>;
```

- [ ] **Step 4: Run database and repository tests GREEN**

Run: `pnpm --filter @loomic/server test -- src/features/agent-runs/agent-execution-repository.test.ts src/features/agent-runs/agent-run-service.test.ts`

Run: `supabase test db`

Expected: PASS, including concurrent terminal races and permission assertions.

- [ ] **Step 5: Commit atomic finalization**

```bash
git add supabase/migrations/20260819000001_agent_tool_event_governance.sql supabase/tests/agent_tool_event_governance.test.sql apps/server/src/features/agent-runs/agent-execution-repository.ts apps/server/src/features/agent-runs/agent-execution-repository.test.ts apps/server/src/features/agent-runs/agent-run-service.ts apps/server/src/features/agent-runs/agent-run-service.test.ts
git commit -m "feat(agent): finalize runs and attempts atomically"
```

### Task 6: Route Every Runtime Exit Through Confirmed Finalization

**Files:**
- Modify: `apps/server/src/agent/runtime.ts`
- Modify: `apps/server/src/agent/runtime.application-wiring.test.ts`
- Modify: `apps/server/src/ws/handler.ts`
- Modify: `apps/server/src/http/runs.ts`
- Modify: `apps/web/src/lib/server-api.ts`
- Modify: `apps/web/src/components/chat-sidebar.tsx`

- [ ] **Step 1: Write failing runtime exit tests**

Cover completion, failure, cancellation, pre-claim failure, parallel sibling
closure, finalization response loss, and status-unconfirmed handling:

```ts
expect(finalizeRun).toHaveBeenCalledOnce();
expect(events.at(-1)).toMatchObject({ type: "run.failed", runId: "run-1" });
expect(openToolEvents).toEqual([
  expect.objectContaining({ type: "tool.failed", toolCallId: "call-open" }),
]);

finalizeRun.mockRejectedValue(new AgentFinalizationUnconfirmedError("corr-1"));
expect(events.some((event) => event.type.startsWith("run."))).toBe(false);
expect(transportErrors).toContainEqual(expect.objectContaining({ code: "run_finalization_unconfirmed" }));
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `pnpm --filter @loomic/server test -- src/agent/runtime.application-wiring.test.ts`

Expected: FAIL because cancellation and error paths currently update attempt and
run independently or fabricate `run.failed` at the WebSocket boundary.

- [ ] **Step 3: Implement one close owner**

Move every exit after acceptance through the supervisor close transition and
`finalizeAgentRun`. Stop lease renewal before finalization, use the state
returned by the database, close remaining tool calls, then publish exactly one
run terminal. Keep `run_finalization_unconfirmed` transport-only and remove the
WebSocket fallback that constructs `run.failed`. Add one authenticated run
status endpoint backed by the session-to-canvas-to-project-to-workspace
authorization join. Return only a confirmed terminal state, `resumable`, or
`active_wait` with a server-bounded `retryAfterMs`; never expose lease or
fencing data. When finalization is unconfirmed, ChatSidebar stops the ended
stream and polls this endpoint before changing the run status.

- [ ] **Step 4: Run focused tests GREEN**

Run: `pnpm --filter @loomic/server test -- src/agent/runtime.application-wiring.test.ts`

Expected: PASS with no active attempt after a terminal run.

- [ ] **Step 5: Commit runtime finalization**

```bash
git add apps/server/src/agent/runtime.ts apps/server/src/agent/runtime.application-wiring.test.ts apps/server/src/ws/handler.ts apps/server/src/http/runs.ts apps/web/src/lib/server-api.ts apps/web/src/components/chat-sidebar.tsx
git commit -m "fix(agent): publish only confirmed run terminals"
```

### Task 7: Make Canvas Commits The Only Refresh Source

**Files:**
- Modify: `supabase/migrations/20260819000001_agent_tool_event_governance.sql`
- Modify: `supabase/tests/agent_tool_event_governance.test.sql`
- Modify: `apps/server/src/features/canvas/canvas-repository.ts`
- Modify: `apps/server/src/features/canvas/canvas-repository.test.ts`
- Modify: `apps/server/src/features/canvas/canvas-service.ts`
- Modify: `apps/server/src/events/domain-event-publisher.ts`
- Modify: `apps/server/src/events/outbox-dispatcher.test.ts`
- Modify: `apps/server/src/agent/runtime.ts`

- [ ] **Step 1: Write failing commit and publisher tests**

Assert read, failed write, successful write, effect replay, and generated asset
attachment produce respectively zero, zero, one, zero, and one logical syncs.
Assert callers cannot choose event type or payload:

```ts
expect(pushToCanvas).toHaveBeenCalledTimes(1);
expect(pushToCanvas).toHaveBeenCalledWith("canvas-1", {
  type: "canvas.sync",
  eventId: "event-1",
  canvasId: "canvas-1",
  revision: 2,
  timestamp: expect.any(String),
});
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `pnpm --filter @loomic/server test -- src/features/canvas/canvas-repository.test.ts src/events/outbox-dispatcher.test.ts src/agent/runtime.application-wiring.test.ts`

Expected: FAIL because tool completion, runtime artifact handling, or callers
can still emit refreshes outside the committed canvas transaction.

- [ ] **Step 3: Add the fixed database event path**

Make canonical canvas RPCs accept only business inputs. A trigger validates a
single-step revision advance and inserts the fixed event:

```sql
insert into public.domain_outbox (
  aggregate_type, aggregate_id, aggregate_version, event_type, payload
) values (
  'canvas', new.id, new.revision, 'canvas.updated', '{}'::jsonb
);
```

Add a partial unique index for one canvas aggregate/revision event, reject
content-only, revision-only, and revision-jump writes, and revoke direct canvas
and outbox mutations from application roles. Map the trusted outbox row to the
public `canvas.sync`; remove all Agent-runtime direct `canvas.sync` calls.

- [ ] **Step 4: Run focused tests GREEN**

Run: `pnpm --filter @loomic/server test -- src/features/canvas/canvas-repository.test.ts src/events/outbox-dispatcher.test.ts src/agent/runtime.application-wiring.test.ts`

Run: `supabase test db`

Expected: PASS with exactly one outbox event for each committed revision.

- [ ] **Step 5: Commit authoritative canvas events**

```bash
git add supabase/migrations/20260819000001_agent_tool_event_governance.sql supabase/tests/agent_tool_event_governance.test.sql apps/server/src/features/canvas/canvas-repository.ts apps/server/src/features/canvas/canvas-repository.test.ts apps/server/src/features/canvas/canvas-service.ts apps/server/src/events/domain-event-publisher.ts apps/server/src/events/outbox-dispatcher.test.ts apps/server/src/agent/runtime.ts
git commit -m "fix(canvas): publish sync only from committed revisions"
```

### Task 8: Centralize Browser Canvas Synchronization

**Files:**
- Create: `apps/web/src/hooks/use-mounted-canvas-sync.ts`
- Create: `apps/web/test/use-mounted-canvas-sync.test.tsx`
- Modify: `apps/web/src/app/canvas/page.tsx`
- Modify: `apps/web/src/components/canvas-editor.tsx`
- Modify: `apps/web/src/components/chat-sidebar.tsx`
- Modify: `apps/web/src/hooks/use-job-fallback-polling.ts`
- Modify: `apps/web/src/hooks/use-canvas-image-generation.ts`

- [ ] **Step 1: Write failing coordinator tests**

Cover duplicate events, out-of-order revisions, event-before-initial-fetch,
coalesced forward fetch, stale snapshot retry, and dirty-draft conflict:

```ts
emit(sync({ eventId: "event-1", canvasId: "canvas-1", revision: 2 }));
emit(sync({ eventId: "event-1", canvasId: "canvas-1", revision: 2 }));
await waitFor(() => expect(fetchCanvas).toHaveBeenCalledTimes(1));

setEditorState({ dirty: true, queuedSave: true });
emit(sync({ eventId: "event-2", canvasId: "canvas-1", revision: 3 }));
expect(replaceScene).not.toHaveBeenCalled();
expect(markConflict).toHaveBeenCalledWith(3);
```

- [ ] **Step 2: Run the web test and confirm RED**

Run: `pnpm --filter @loomic/web test -- use-mounted-canvas-sync.test.tsx`

Expected: FAIL because ChatSidebar and polling callbacks own canvas refreshes
and there is no monotonic coordinator.

- [ ] **Step 3: Implement one mounted-canvas coordinator**

The hook subscribes before initial snapshot fetch, keeps bounded `eventId`
deduplication, tracks `highestObservedRevision` and `highestAppliedRevision`,
coalesces forward fetches, and refuses to replace a dirty/queued/in-flight
draft. Expose editor persistence state explicitly:

```ts
export interface CanvasPersistenceState {
  readonly dirty: boolean;
  readonly queued: boolean;
  readonly saving: boolean;
  readonly conflictRevision: number | null;
}
```

Only an explicit content-and-revision reset clears conflict and resumes
autosave. Remove `onCanvasSync` from `ChatSidebar`; job polling may update job UI
but cannot fetch or write canvas state. Artifact display never mutates canvas;
explicit placement remains a normal revision-checked browser commit.

- [ ] **Step 4: Run web tests GREEN**

Run: `pnpm --filter @loomic/web test -- use-mounted-canvas-sync.test.tsx`

Expected: PASS with one logical refresh and preserved local drafts.

- [ ] **Step 5: Commit browser synchronization**

```bash
git add apps/web/src/hooks/use-mounted-canvas-sync.ts apps/web/test/use-mounted-canvas-sync.test.tsx apps/web/src/app/canvas/page.tsx apps/web/src/components/canvas-editor.tsx apps/web/src/components/chat-sidebar.tsx apps/web/src/hooks/use-job-fallback-polling.ts apps/web/src/hooks/use-canvas-image-generation.ts
git commit -m "fix(canvas): centralize mounted canvas synchronization"
```

### Task 9: Make Public Reducers Idempotent And Errors Actionable

**Files:**
- Create: `apps/web/src/lib/tool-event-reducer.ts`
- Create: `apps/web/test/tool-event-reducer.test.ts`
- Modify: `apps/web/src/hooks/use-chat-stream.ts`
- Modify: `apps/web/src/components/chat-sidebar.tsx`
- Modify: `apps/server/src/utils/error-sanitizer.ts`
- Modify: `apps/server/src/agent/runtime.ts`

- [ ] **Step 1: Write failing reducer and logging tests**

Assert an exact public replay is a no-op, conflicting identity fails once,
`tool.failed` closes the correct card, and valid `run.failed` does not call
`console.error`:

```ts
const once = reduceToolEvent(initial, started);
expect(reduceToolEvent(once, started)).toBe(once);
expect(() => reduceToolEvent(once, { ...started, toolName: "other" }))
  .toThrow("tool_event_conflict");
expect(consoleError).not.toHaveBeenCalled();
```

- [ ] **Step 2: Run web and server tests and confirm RED**

Run: `pnpm --filter @loomic/web test -- tool-event-reducer.test.ts`

Run: `pnpm --filter @loomic/server test -- src/agent/runtime.application-wiring.test.ts`

Expected: FAIL because lifecycle reduction is embedded in the hook and expected
run failure is logged as a browser console exception.

- [ ] **Step 3: Implement the shared pure reducer and bounded diagnostics**

Use `(runId, toolCallId)` as the reducer key. Exact duplicate public events are
silent; reordered or payload-conflicting events produce one bounded protocol
diagnostic with a correlation ID. Valid `tool.failed` and `run.failed` update UI
state without `console.error`. Server orchestration logs the typed sanitized
database fields once; repositories preserve them but do not log. Never log
tokens, complete canvas content, raw media, or unrestricted tool payloads.

- [ ] **Step 4: Run focused tests GREEN**

Run: `pnpm --filter @loomic/web test -- tool-event-reducer.test.ts`

Run: `pnpm --filter @loomic/server test -- src/agent/runtime.application-wiring.test.ts`

Expected: PASS and no `{}` error serialization.

- [ ] **Step 5: Commit reducer and diagnostics**

```bash
git add apps/web/src/lib/tool-event-reducer.ts apps/web/test/tool-event-reducer.test.ts apps/web/src/hooks/use-chat-stream.ts apps/web/src/components/chat-sidebar.tsx apps/server/src/utils/error-sanitizer.ts apps/server/src/agent/runtime.ts
git commit -m "fix(agent): reduce replayed events idempotently"
```

### Task 10: Full Verification And Browser Acceptance

**Files:**
- Create: `tests/agent-tool-event-governance.spec.ts`
- Modify: `docs/superpowers/2026-08-19-agent-tool-event-governance-design.md`

- [ ] **Step 1: Add the authenticated acceptance regression**

Automate inspection, invalid-then-corrected mutation, successful mutation,
reconnect during a call, delayed canvas event, and remote mutation with a dirty
draft. The key assertions are:

```ts
await expect(page.getByTestId("tool-call-model-call-1")).toHaveCount(1);
await expect(page.getByTestId("tool-call-model-call-1")).toHaveAttribute("data-status", "completed");
expect(await canvasRefreshCount(page)).toBe(1);
await expect(page.getByRole("alert")).toContainText("changed elsewhere");
```

- [ ] **Step 2: Run package-level verification**

Run: `pnpm --filter @loomic/shared test`

Run: `pnpm --filter @loomic/server test`

Run: `pnpm --filter @loomic/web test`

Expected: all PASS without unexpected warnings or console errors.

- [ ] **Step 3: Run repository-wide verification**

Run: `pnpm lint`

Run: `pnpm typecheck`

Run: `pnpm test`

Run: `pnpm build`

Run: `supabase test db`

Run: `pnpm test:e2e -- tests/agent-tool-event-governance.spec.ts`

Expected: all commands PASS.

- [ ] **Step 4: Verify the original failure signature is gone**

Inspect structured logs for the acceptance run. Assert one business handler
entry, one public started record, one terminal record, one committed
`canvas.updated` row for a successful write, and no expected `run.failed`
browser console exception. Confirm that autosave timeout behavior is unchanged
and remains a separately tracked concern.

- [ ] **Step 5: Update design status and commit verification**

Change the design status from `Architecture-reviewed; awaiting user approval
for implementation planning` to `Implemented and verified`, record the exact
verified dependency versions, and commit:

```bash
git add tests/agent-tool-event-governance.spec.ts docs/superpowers/2026-08-19-agent-tool-event-governance-design.md
git commit -m "test(agent): verify tool event governance end to end"
```
