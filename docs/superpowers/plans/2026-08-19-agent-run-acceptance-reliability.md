# Agent Run Acceptance Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Agent run acceptance fast, idempotent, recoverable, observable, and safe to retry without leaking credentials or creating duplicate executions.

**Architecture:** A shared application service resolves one canonical session/Canvas scope, selects the model from that scope, and performs bounded atomic acceptance with reconciliation. WebSocket and HTTP entry points use that service; the runtime returns explicit execution ownership so only one handler consumes a stream. The browser correlates pre-ACK errors by `clientRequestId` and reuses the same normalized request for acceptance retries.

**Tech Stack:** TypeScript, Fastify 5, Supabase/PostgREST, PostgreSQL, LangGraph runtime, React 19, Next.js 15, Zod, Vitest.

---

## File Map

- Create `apps/server/src/application/agent/agent-run-errors.ts`: stable Agent acceptance errors and abortable deadline helper.
- Create `apps/server/src/application/agent/authorized-run-context.ts`: immutable canonical run context and one-query resolver.
- Create `apps/server/src/application/agent/prepare-agent-run.ts`: shared context, model, acceptance, and reconciliation orchestration.
- Modify `apps/server/src/application/agent/accept-agent-run.ts`: consume pre-authorized context only.
- Modify `apps/server/src/features/agent-runs/agent-execution-repository.ts`: abortable acceptance and idempotency lookup.
- Modify `apps/server/src/agent/runtime.ts`: explicit created/existing/rehydrated registration ownership.
- Modify `apps/server/src/ws/handler.ts` and `apps/server/src/http/runs.ts`: use shared preparation and correlated errors.
- Modify `apps/server/src/events/domain-event-publisher.ts`: acknowledge supported Agent lifecycle events.
- Create `apps/server/src/logging/sanitize-log-data.ts`: URL and nested credential redaction.
- Modify `apps/server/src/app.ts` and `apps/server/src/ws/logger.ts`: apply redaction and structured stage logging.
- Modify `packages/shared/src/errors.ts`, `packages/shared/src/http.ts`, and `packages/shared/src/ws-protocol.ts`: stable pre-ACK and terminal Agent error codes plus correlated WebSocket error schema.
- Modify `apps/web/src/hooks/use-websocket.ts`: correlate ACK/error callbacks by client request ID.
- Modify `apps/web/src/components/chat-sidebar.tsx`: retain normalized requests and retry acceptance without duplicating messages.

### Task 1: Shared Agent Error And WebSocket Contracts

**Files:**
- Modify: `packages/shared/src/errors.ts`
- Modify: `packages/shared/src/http.ts`
- Modify: `packages/shared/src/ws-protocol.ts`
- Test: `packages/shared/src/contracts.test.ts`

- [ ] **Step 1: Write failing contract tests**

Add tests that require all Agent error codes and correlated WebSocket errors:

```ts
it("accepts Agent acceptance boundary codes", () => {
  for (const code of [
    "agent_context_timeout",
    "agent_context_unavailable",
    "agent_context_forbidden",
    "agent_acceptance_indeterminate",
    "agent_acceptance_conflict",
    "agent_acceptance_unavailable",
    "agent_acceptance_failed",
    "agent_runtime_registration_failed",
    "agent_persistence_timeout",
    "agent_first_event_timeout",
  ] as const) {
    expect(boundaryErrorCodeSchema.parse(code)).toBe(code);
  }
});

it("accepts stable terminal Agent timeout codes", () => {
  for (const code of [
    "agent_persistence_timeout",
    "agent_first_event_timeout",
  ] as const) {
    expect(errorCodeSchema.parse(code)).toBe(code);
  }
});

it("parses a correlated pre-ACK Agent error", () => {
  expect(
    wsErrorMessageSchema.parse({
      type: "error",
      action: "agent.run",
      clientRequestId: "request-1",
      requestId: "req-1",
      retryable: true,
      error: {
        code: "agent_acceptance_indeterminate",
        message: "Agent acceptance is still being confirmed.",
      },
    }),
  ).toMatchObject({
    action: "agent.run",
    clientRequestId: "request-1",
    retryable: true,
  });
});
```

- [ ] **Step 2: Run the shared test and verify RED**

Run: `rtk pnpm --filter @loomic/shared test`

Expected: FAIL because the Agent codes and correlation fields are not in the schemas.

- [ ] **Step 3: Add the contract fields**

Define the ten values once as `agentErrorCodeValues` in `errors.ts`. Include them in both the transport `applicationErrorCodeSchema` and the stream `errorCodeSchema`, so pre-ACK envelopes and terminal `run.failed` events use the same stable codes. Extend the existing error envelope rather than introducing a second error message type:

```ts
export const wsErrorMessageSchema = errorEnvelopeSchema.extend({
  type: z.literal("error"),
  action: z.string().min(1).optional(),
  clientRequestId: z.string().min(1).max(128).optional(),
  requestId: z.string().min(1).optional(),
  retryable: z.boolean().default(false),
});
```

- [ ] **Step 4: Run shared tests and typecheck**

Run: `rtk pnpm --filter @loomic/shared test`

Expected: PASS.

Run: `rtk pnpm --filter @loomic/shared typecheck`

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/errors.ts packages/shared/src/http.ts packages/shared/src/ws-protocol.ts packages/shared/src/contracts.test.ts
git commit -m "feat(agent): define correlated acceptance errors"
```

### Task 2: Canonical Authorized Run Context

**Files:**
- Create: `apps/server/src/application/agent/agent-run-errors.ts`
- Create: `apps/server/src/application/agent/authorized-run-context.ts`
- Create: `apps/server/src/application/agent/authorized-run-context.test.ts`
- Modify: `apps/server/src/app.ts`

- [ ] **Step 1: Write failing context resolver tests**

```ts
const principal = {
  accessToken: "current-token",
  userId: "user-1",
};

it("resolves one canonical session scope and preserves conversation identity", async () => {
  const resolveSessionScope = vi.fn(async () => ({
    canvasId: "canvas-1",
    projectId: "project-1",
    sessionId: "session-1",
    threadId: "thread-1",
    workspaceId: "workspace-1",
  }));
  const resolve = createAuthorizedRunContextResolver({ resolveSessionScope });

  await expect(
    resolve(principal, {
      canvasId: "canvas-1",
      conversationId: "conversation-independent",
      sessionId: "session-1",
    }),
  ).resolves.toMatchObject({
    canvasId: "canvas-1",
    conversationId: "conversation-independent",
    threadId: "thread-1",
    workspaceId: "workspace-1",
  });
  expect(resolveSessionScope).toHaveBeenCalledOnce();
});

it("rejects a request canvas outside the session scope", async () => {
  const resolve = createAuthorizedRunContextResolver({
    resolveSessionScope: async () => ({
      canvasId: "canvas-1",
      projectId: "project-1",
      sessionId: "session-1",
      threadId: "thread-1",
      workspaceId: "workspace-1",
    }),
  });
  await expect(
    resolve(principal, {
      canvasId: "canvas-other",
      conversationId: "conversation-1",
      sessionId: "session-1",
    }),
  ).rejects.toMatchObject({ code: "agent_context_forbidden" });
});
```

- [ ] **Step 2: Run the resolver test and verify RED**

Run: `rtk pnpm --filter @loomic/server test -- src/application/agent/authorized-run-context.test.ts`

Expected: FAIL because the resolver module does not exist.

- [ ] **Step 3: Implement stable errors and the frozen context**

```ts
export class AgentRunError extends AppError {
  readonly retryable: boolean;

  constructor(options: {
    code: AppErrorCode;
    statusCode: number;
    message: string;
    retryable: boolean;
    cause?: unknown;
  }) {
    super({ ...options, expose: true });
    this.retryable = options.retryable;
  }
}

export type AuthorizedAgentRunContext = Readonly<{
  accessToken: string;
  canvasId: string;
  conversationId: string;
  projectId: string;
  sessionId: string;
  threadId: string;
  userId: string;
  workspaceId: string;
}>;

export function createAuthorizedRunContextResolver(options: {
  resolveSessionScope: (
    principal: { accessToken: string; userId: string },
    sessionId: string,
    signal?: AbortSignal,
  ) => Promise<Omit<AuthorizedAgentRunContext, "accessToken" | "conversationId" | "userId">>;
}) {
  return async (
    principal: { accessToken: string; userId: string },
    request: Pick<RunCreateRequest, "canvasId" | "conversationId" | "sessionId">,
    signal?: AbortSignal,
  ): Promise<AuthorizedAgentRunContext> => {
    const scope = await options.resolveSessionScope(principal, request.sessionId, signal);
    if (scope.canvasId !== request.canvasId || scope.sessionId !== request.sessionId) {
      throw new AgentRunError({
        code: "agent_context_forbidden",
        statusCode: 403,
        message: "You do not have access to this Agent context.",
        retryable: false,
      });
    }
    return Object.freeze({ ...scope, ...principal, conversationId: request.conversationId });
  };
}
```

- [ ] **Step 4: Wire one user-scoped Supabase query**

In `app.ts`, replace the separate Canvas/session/thread resolvers with one adapter selecting:

```ts
let query = createUserClient(principal.accessToken)
  .from("chat_sessions")
  .select(
    "id, thread_id, canvas_id, canvases!inner(id, project_id, projects!inner(workspace_id))",
  )
  .eq("id", sessionId);
if (signal) query = query.abortSignal(signal);
const { data, error } = await query.maybeSingle();
```

Normalize it into `{ sessionId, threadId, canvasId, projectId, workspaceId }`; reject missing `thread_id` or relationship fields with `agent_context_forbidden`. A completed query with no matching row is also forbidden, while a Supabase/PostgREST dependency error maps to retryable `agent_context_unavailable`; never report an outage as an authorization denial.

- [ ] **Step 5: Run resolver tests and server typecheck**

Run: `rtk pnpm --filter @loomic/server test -- src/application/agent/authorized-run-context.test.ts`

Expected: PASS.

Run: `rtk pnpm --filter @loomic/server typecheck`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/application/agent/agent-run-errors.ts apps/server/src/application/agent/authorized-run-context.ts apps/server/src/application/agent/authorized-run-context.test.ts apps/server/src/app.ts
git commit -m "refactor(agent): resolve canonical run context once"
```

### Task 3: Abortable Acceptance And Indeterminate Reconciliation

**Files:**
- Modify: `apps/server/src/features/agent-runs/agent-execution-repository.ts`
- Modify: `apps/server/src/features/agent-runs/agent-execution-repository.test.ts`
- Modify: `apps/server/src/application/agent/accept-agent-run.ts`
- Modify: `apps/server/src/application/agent/accept-agent-run.test.ts`
- Create: `apps/server/src/application/agent/prepare-agent-run.ts`
- Create: `apps/server/src/application/agent/prepare-agent-run.test.ts`

- [ ] **Step 1: Write failing repository lookup tests**

```ts
it("finds a durable acceptance by user and client request", async () => {
  const repository = new MemoryAgentExecutionRepository();
  await repository.accept(acceptance);
  await expect(
    repository.findAcceptance({
      clientRequestId: "request-1",
      userId: "user-1",
    }),
  ).resolves.toEqual({
    model: "openai:test-model",
    requestDigest: "digest-1",
    runId: "run-1",
  });
});
```

Add `signal?: AbortSignal` to `accept` and `findAcceptance`. The Supabase implementation must call `.abortSignal(signal)` on both RPC and lookup builders when provided.

Also add adapter tests proving: `57014`, `55P03`, `40001`, and `40P01` are definitive retryable database failures; an RPC transport rejection, an aborted fetch, or a malformed success payload is indeterminate and therefore requires reconciliation; the custom conflict exception remains non-retryable. Tests must assert only stable internal kinds/codes and never raw database messages.

- [ ] **Step 2: Run repository tests and verify RED**

Run: `rtk pnpm --filter @loomic/server test -- src/features/agent-runs/agent-execution-repository.test.ts`

Expected: FAIL because `findAcceptance` is missing.

- [ ] **Step 3: Implement repository lookup**

```ts
export interface PersistedAgentAcceptance {
  readonly model?: string;
  readonly requestDigest: string;
  readonly runId: string;
}

findAcceptance(input: {
  readonly clientRequestId: string;
  readonly userId: string;
  readonly signal?: AbortSignal;
}): Promise<PersistedAgentAcceptance | null>;
```

The PostgREST adapter selects `id, request_digest, model` from `agent_runs`, filters by `user_id` and `client_request_id`, and throws a typed, non-public repository failure without exposing database text. The existing partial unique index on `(user_id, client_request_id)` serves this lookup; no migration is required. Apply `.abortSignal(signal)` to the query builder only when a signal is supplied.

Normalize acceptance failures into `conflict`, `definitive_unavailable`, `definitive_failed`, or `indeterminate`. PostgreSQL statement cancellation/lock/serialization/deadlock codes are definitive because the transaction rolled back; transport rejection, abort, and malformed success responses are indeterminate because the transaction may have committed. Keep this classification in the repository adapter and map it to public `AgentRunError` values in the application service.

- [ ] **Step 4: Refactor acceptance to consume authorized context**

Export a pure `createAgentRunRequestDigest(request, context)` helper that hashes a stable JSON snapshot of `{ requestWithoutAccessToken, scope, userId }`. `createPrepareAgentRun` computes this digest before the repository boundary so it remains available if the acceptance RPC times out. Replace resolver callbacks in `createAcceptAgentRun` with this call shape:

```ts
acceptAgentRun({
  context,
  model,
  request,
  requestDigest,
  signal,
});
```

Build the execution context and call the repository exactly once. Return `{ created, requestDigest, runId, status: "accepted" }`. Never include `accessToken` in the digest or a repository/log payload other than the in-memory runtime registration.

- [ ] **Step 5: Write failing preparation/reconciliation tests**

```ts
it("reconciles a late acceptance after the RPC deadline", async () => {
  const requestDigest = createAgentRunRequestDigest(request, context);
  const acceptAgentRun = vi.fn(() => new Promise(() => undefined));
  const findAcceptance = vi.fn(async () => ({
    model: "openai:gpt-5.6-terra",
    requestDigest,
    runId: "run-1",
  }));
  const prepare = createPrepareAgentRun({
    acceptAgentRun,
    acceptanceTimeoutMs: 5,
    contextTimeoutMs: 50,
    findAcceptance,
    modelTimeoutMs: 50,
    reconcileTimeoutMs: 50,
    resolveContext: async () => context,
    resolveWorkspaceModel: async () => "openai:gpt-5.6-terra",
  });

  await expect(prepare(request, principal)).resolves.toMatchObject({
    accepted: { created: false, runId: "run-1" },
  });
});

it("reuses the model persisted by the original acceptance", async () => {
  const requestDigest = createAgentRunRequestDigest(request, context);
  const prepare = createPrepareAgentRun({
    acceptAgentRun: vi.fn(() => new Promise(() => undefined)),
    acceptanceTimeoutMs: 5,
    contextTimeoutMs: 50,
    findAcceptance: vi.fn(async () => ({
      model: "openai:original-model",
      requestDigest,
      runId: "run-1",
    })),
    modelTimeoutMs: 50,
    reconcileTimeoutMs: 50,
    resolveContext: async () => context,
    resolveWorkspaceModel: async () => "openai:new-default",
  });

  await expect(prepare(request, principal)).resolves.toMatchObject({
    model: "openai:original-model",
  });
});

it("returns indeterminate when no committed row is visible", async () => {
  // Same setup, but findAcceptance resolves null.
  await expect(prepare(request, principal)).rejects.toMatchObject({
    code: "agent_acceptance_indeterminate",
    retryable: true,
  });
});
```

- [ ] **Step 6: Implement bounded preparation**

Implement `runWithDeadline` as a real `Promise.race` between the dependency and a rejecting timer. The timer aborts an `AbortController`; `finally` clears the timer and removes any parent-signal listener. This guarantees completion even when a dependency ignores cancellation, while the attached race handler prevents a later rejection from becoming unhandled. Add a fake-timer test proving a never-settling dependency rejects on schedule and observes an aborted signal.

`createPrepareAgentRun` executes context (4s), then canonical workspace model lookup (2s, fallback on failure), then acceptance (4s). An acceptance deadline or repository `indeterminate` result enters 2s reconciliation and compares the precomputed digest before returning an existing run. A digest mismatch is `agent_acceptance_conflict`; no row, lookup timeout, or lookup failure is `agent_acceptance_indeterminate`, because none proves rollback. A `definitive_unavailable` acceptance is `agent_acceptance_unavailable`; a `definitive_failed` acceptance is `agent_acceptance_failed`. When acceptance returns `created: false`, perform the same bounded lookup so rehydration uses the model stored by the original acceptance rather than current workspace settings. Return that effective value as `prepared.model`.

Inject a structured logger and clock into preparation. Emit the exact `agent.context.resolve.*`, `agent.model.resolve.*`, and `agent.accept.*` events from the design with `requestId`, `clientRequestId`, canonical IDs available at that point, `durationMs`, `errorCode`, and `retryable`; log only sanitized classifications, never prompts, tokens, raw errors, or upstream response bodies.

- [ ] **Step 7: Run focused Agent application tests**

Run: `rtk pnpm --filter @loomic/server test -- src/application/agent/accept-agent-run.test.ts src/application/agent/prepare-agent-run.test.ts src/features/agent-runs/agent-execution-repository.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/application/agent apps/server/src/features/agent-runs/agent-execution-repository.ts apps/server/src/features/agent-runs/agent-execution-repository.test.ts
git commit -m "feat(agent): reconcile indeterminate acceptance"
```

### Task 4: Single Runtime Execution Ownership And Shared Entrypoints

**Files:**
- Modify: `apps/server/src/agent/runtime.ts`
- Modify: `apps/server/src/agent/runtime.application-wiring.test.ts`
- Modify: `apps/server/src/ws/handler.ts`
- Modify: `apps/server/src/ws/handler.authorization.test.ts`
- Modify: `apps/server/src/http/runs.ts`
- Modify: `apps/server/src/http/runs.authorization.test.ts`
- Modify: `apps/server/src/app.ts`

- [ ] **Step 1: Write failing runtime ownership tests**

```ts
it("returns existing_active without exposing a second stream owner", () => {
  const service = createSubject();
  const first = service.registerRun(request, { durableCreated: true, runId: "run-1" });
  const replay = service.registerRun(request, { durableCreated: false, runId: "run-1" });
  expect(first.ownership).toBe("created");
  expect(replay.ownership).toBe("existing_active");
  expect(replay.response.runId).toBe("run-1");
});

it("returns rehydrated when persistence knows a run absent from memory", () => {
  const service = createSubject();
  expect(
    service.registerRun(request, { durableCreated: false, runId: "run-1" }).ownership,
  ).toBe("rehydrated");
});
```

- [ ] **Step 2: Run runtime tests and verify RED**

Run: `rtk pnpm --filter @loomic/server test -- src/agent/runtime.application-wiring.test.ts`

Expected: FAIL because `registerRun` and ownership do not exist.

- [ ] **Step 3: Implement registration outcomes**

```ts
type RuntimeRegistration = {
  ownership: "created" | "existing_active" | "rehydrated";
  response: RunCreateResponse;
};

registerRun(input, options): RuntimeRegistration {
  const existing = runs.get(options.runId);
  if (existing) {
    return { ownership: "existing_active", response: responseFrom(existing) };
  }
  const ownership = options.durableCreated ? "created" : "rehydrated";
  runs.set(options.runId, createRuntimeRecord(input, options));
  return { ownership, response: responseFrom(runs.get(options.runId)!) };
}
```

Keep `createRun` as a compatibility wrapper returning `registerRun(...).response` until all internal tests are migrated.

- [ ] **Step 4: Write failing runtime deadline tests**

Add fake-timer tests to `runtime.application-wiring.test.ts`:

```ts
it("fails a run when persistence initialization exceeds its deadline", async () => {
  const service = createSubject({
    agentPersistenceService: { getPersistence: vi.fn(() => new Promise(() => undefined)) },
    persistenceTimeoutMs: 10,
  });
  const eventPromise = service.streamRun("run-1").next();
  await vi.advanceTimersByTimeAsync(10);
  await expect(eventPromise).resolves.toMatchObject({
    value: { type: "run.failed", error: { code: "agent_persistence_timeout" } },
  });
});

it("fails a run when no model event arrives before its deadline", async () => {
  const service = createSubject({ firstEventTimeoutMs: 30 });
  const events = service.streamRun("run-1");
  await expect(events.next()).resolves.toMatchObject({ value: { type: "run.started" } });
  const eventPromise = events.next();
  await vi.advanceTimersByTimeAsync(30);
  await expect(eventPromise).resolves.toMatchObject({
    value: { type: "run.failed", error: { code: "agent_first_event_timeout" } },
  });
});
```

- [ ] **Step 5: Bound persistence initialization and the first model event**

Add injectable production defaults `persistenceTimeoutMs: 10_000` and `firstEventTimeoutMs: 30_000`. Wrap `getPersistence()` with `runWithDeadline`. Iterate the adapted stream explicitly: deliver `run.started` immediately, then race the next iterator result against the first-event deadline; after the first non-`run.started` event, continue without that deadline. On timeout, abort the run controller, close the iterator, persist the stable failure, and yield exactly one `run.failed`. Preserve the `AgentRunError.code` in `toFailedEvent` instead of collapsing it to `run_failed`.

Emit `agent.persistence.init.completed|failed` and `agent.model.first_event|failed` with `runId`, `durationMs`, stable `errorCode`, and `retryable`; never log the prompt or upstream error body.

- [ ] **Step 6: Write failing WebSocket replay tests**

Add a handler test where preparation returns `created: false` and runtime registration returns `existing_active`. Assert one ACK with the original `clientRequestId`, zero `streamRun` calls, and no `clearActiveRun` call by the replay handler. Add a created case asserting `setActiveRun` occurs before ACK and one stream begins.

- [ ] **Step 7: Use shared preparation in WS and HTTP**

Replace duplicate authorization/thread/model/acceptance work with injected `prepareAgentRun`. In WebSocket handling:

```ts
const prepared = await services.prepareAgentRun(payload, authenticatedUser);
const registration = agentRuns.registerRun(payload, {
  accessToken: authenticatedUser.accessToken,
  durableCreated: prepared.accepted.created,
  model: prepared.model,
  runId: prepared.accepted.runId,
  threadId: prepared.context.threadId,
  userId: prepared.context.userId,
});
connectionManager.bindCanvas(connectionId, prepared.context.canvasId);
connectionManager.setActiveRun(prepared.context.canvasId, registration.response.runId);
sendAck({ ...registration.response, clientRequestId: payload.clientRequestId });
if (registration.ownership === "existing_active") return;
await ownRunStream(registration.response.runId);
```

Only the owner path enters the stream `try/finally` that clears active state. HTTP uses the same preparation and registration service but retains its current `202` response contract.

- [ ] **Step 8: Emit correlated pre-ACK errors**

Update `sendCommandError` to serialize the shared nested envelope and include `action`, `clientRequestId`, `requestId`, and `retryable` for Agent commands. Preserve safe generic output for unknown exceptions.

- [ ] **Step 9: Run focused entrypoint tests**

Run: `rtk pnpm --filter @loomic/server test -- src/ws/handler.authorization.test.ts src/http/runs.authorization.test.ts src/agent/runtime.application-wiring.test.ts`

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/server/src/agent/runtime.ts apps/server/src/agent/runtime.application-wiring.test.ts apps/server/src/ws/handler.ts apps/server/src/ws/handler.authorization.test.ts apps/server/src/http/runs.ts apps/server/src/http/runs.authorization.test.ts apps/server/src/app.ts
git commit -m "feat(agent): enforce single runtime stream ownership"
```

### Task 5: Agent Acceptance Outbox Settlement

**Files:**
- Modify: `apps/server/src/events/domain-event-publisher.ts`
- Modify: `apps/server/src/events/outbox-dispatcher.test.ts`

- [ ] **Step 1: Write the failing lifecycle-event test**

```ts
it("acknowledges a valid Agent acceptance lifecycle event", async () => {
  const publish = createDomainEventPublisher({
    pushCanvas: vi.fn(),
    sendToUser: vi.fn(),
    rememberCanvasEvent: vi.fn(() => true),
  });
  await expect(
    publish({
      ...event,
      aggregate_type: "agent_run",
      event_type: "agent.run.accepted",
      payload: { attemptId: "attempt-1", runId: event.aggregate_id },
    }),
  ).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run the outbox test and verify RED**

Run: `rtk pnpm --filter @loomic/server test -- src/events/outbox-dispatcher.test.ts`

Expected: FAIL with `unsupported_outbox_aggregate`.

- [ ] **Step 3: Handle only the supported Agent lifecycle event**

```ts
if (event.aggregate_type === "agent_run") {
  if (
    event.event_type !== "agent.run.accepted" ||
    event.payload.runId !== event.aggregate_id ||
    typeof event.payload.attemptId !== "string"
  ) {
    throw codedError("invalid_agent_run_event");
  }
  return;
}
```

Keep unknown Agent event types rejected so schema drift is visible.

- [ ] **Step 4: Run outbox tests**

Run: `rtk pnpm --filter @loomic/server test -- src/events/outbox-dispatcher.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/events/domain-event-publisher.ts apps/server/src/events/outbox-dispatcher.test.ts
git commit -m "fix(agent): settle accepted run outbox events"
```

### Task 6: Correlated Browser Errors And Stable Acceptance Retry

**Files:**
- Modify: `apps/web/src/hooks/use-websocket.ts`
- Create: `apps/web/test/use-websocket.test.tsx`
- Modify: `apps/web/src/components/chat-sidebar.tsx`
- Modify: `apps/web/test/chat-sidebar.test.tsx`

- [ ] **Step 1: Write failing WebSocket correlation tests**

Test that `startRun` registers callbacks by `clientRequestId`, resolves the matching ACK, and rejects the matching `type: "error"` without waiting for another command:

```ts
const callbacks = { onAck: vi.fn(), onError: vi.fn() };
result.current.startRun(request, callbacks);
serverMessage({
  type: "error",
  action: "agent.run",
  clientRequestId: "request-1",
  requestId: "req-1",
  retryable: true,
  error: {
    code: "agent_acceptance_indeterminate",
    message: "Agent acceptance is still being confirmed.",
  },
});
expect(callbacks.onError).toHaveBeenCalledOnce();
expect(callbacks.onAck).not.toHaveBeenCalled();
```

- [ ] **Step 2: Run the hook test and verify RED**

Run: `rtk pnpm --filter @loomic/web test -- test/use-websocket.test.tsx`

Expected: FAIL because `startRun` has no correlated error callback.

- [ ] **Step 3: Implement request-keyed pending callbacks**

```ts
type RunCallbacks = {
  onAck(ack: WsCommandAck): void;
  onError(error: WsErrorMessage): void;
};

const runListeners = useRef(new Map<string, RunCallbacks>());

function startRun(payload: RunCreateRequest, callbacks: RunCallbacks): boolean {
  runListeners.current.set(payload.clientRequestId, callbacks);
  const sent = sendCommand("agent.run", payload);
  if (!sent) runListeners.current.delete(payload.clientRequestId);
  return sent;
}
```

For Agent ACKs read `payload.clientRequestId`; for correlated errors read top-level `clientRequestId`. Delete only the matching listener.

- [ ] **Step 4: Write failing sidebar retry tests**

Assert that a retryable pre-ACK error renders localized failure text and a retry command. Clicking retry calls `startRun` again with the same `clientRequestId`, does not call `saveMessage` again, and does not append another user message. Assert a fresh manual send uses a new ID.

- [ ] **Step 5: Retain a normalized pending request in the sidebar**

Create the request once before transport submission, excluding `accessToken` from retained state. Attach `accessTokenRef.current` only when calling `startRun`. Store `{ request, assistantId, sessionId }` until ACK or a terminal non-retryable error. Add a compact retry button using the existing Lucide `RotateCcw` icon and localized labels. Increase the outer ACK timer to 15 seconds and map stable codes to localized text; unknown errors include the safe request ID.

- [ ] **Step 6: Run web tests and typecheck**

Run: `rtk pnpm --filter @loomic/web test -- test/use-websocket.test.tsx test/chat-sidebar.test.tsx`

Expected: PASS.

Run: `rtk pnpm --filter @loomic/web typecheck`

Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/hooks/use-websocket.ts apps/web/src/components/chat-sidebar.tsx apps/web/test/use-websocket.test.tsx apps/web/test/chat-sidebar.test.tsx
git commit -m "fix(agent): retry acceptance with a stable request id"
```

### Task 7: Credential-Safe Structured Logging

**Files:**
- Create: `apps/server/src/logging/sanitize-log-data.ts`
- Create: `apps/server/src/logging/sanitize-log-data.test.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/ws/logger.ts`

- [ ] **Step 1: Write failing sanitization tests**

```ts
it("redacts credentials from URLs and nested log data", () => {
  const sentinel = "sentinel-secret-token";
  const sanitized = sanitizeLogData({
    accessToken: sentinel,
    nested: { apiKey: sentinel, safe: "kept" },
    url: `/api/ws?token=${sentinel}&connectionId=connection-1`,
  });
  const serialized = JSON.stringify(sanitized);
  expect(serialized).not.toContain(sentinel);
  expect(serialized).toContain("connection-1");
  expect(serialized).toContain("kept");
});

it("never returns unsanitized values at the depth or cycle boundary", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  cyclic.deep = { a: { b: { token: "sentinel-secret-token" } } };
  expect(() => JSON.stringify(sanitizeLogData(cyclic, { maxDepth: 2 }))).not.toThrow();
  expect(JSON.stringify(sanitizeLogData(cyclic, { maxDepth: 2 }))).not.toContain(
    "sentinel-secret-token",
  );
});
```

- [ ] **Step 2: Run sanitizer test and verify RED**

Run: `rtk pnpm --filter @loomic/server test -- src/logging/sanitize-log-data.test.ts`

Expected: FAIL because the sanitizer does not exist.

- [ ] **Step 3: Implement bounded recursive redaction**

```ts
const SECRET_KEYS = /^(authorization|proxy-authorization|cookie|set-cookie|token|access[_-]?token|refresh[_-]?token|api[_-]?key|password|secret|client[_-]?secret)$/i;

export function sanitizeRequestUrl(rawUrl: string): string {
  const url = new URL(rawUrl, "http://redaction.local");
  for (const key of [...url.searchParams.keys()]) {
    if (SECRET_KEYS.test(key)) url.searchParams.set(key, "[REDACTED]");
  }
  return `${url.pathname}${url.search}`;
}

export function sanitizeLogData(
  value: unknown,
  options: { maxDepth?: number; secretValues?: readonly string[] } = {},
): unknown {
  return sanitizeValue(value, {
    ancestors: new WeakSet(),
    depth: 0,
    maxDepth: options.maxDepth ?? 8,
    secretValues: options.secretValues?.filter(Boolean) ?? [],
  });
}
```

`sanitizeValue` must replace the depth boundary with `"[TRUNCATED]"`, cycles with `"[CIRCULAR]"`, accessor/non-plain objects with a safe summary, secret-keyed fields with `"[REDACTED]"`, and configured secret-value substrings inside strings with `"[REDACTED]"`. It must never return the original object at a truncation boundary. `sanitizeRequestUrl` catches invalid input and returns only a safe pathname fallback.

- [ ] **Step 4: Apply sanitization at both log boundaries**

Configure Fastify's request serializer to emit request ID, method, sanitized pathname/query, host, remote address, and remote port without raw headers. Pass every pipeline logger base/context object through `sanitizeLogData` before rendering stdout or JSONL, supplying non-empty configured Supabase/provider credentials as value redactions. Keep the stage names defined by the design and include `durationMs`, `errorCode`, and `retryable` from preparation and runtime. Do not pass raw upstream error objects or messages to these stage logs.

- [ ] **Step 5: Add an application handshake regression test**

Start an injected app logger with a sentinel WebSocket token, perform the handshake path, and assert captured structured output contains neither the sentinel token nor `Bearer <sentinel>`.

- [ ] **Step 6: Run logging and application tests**

Run: `rtk pnpm --filter @loomic/server test -- src/logging/sanitize-log-data.test.ts src/app.env.test.ts src/http/error-handler.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/logging apps/server/src/app.ts apps/server/src/ws/logger.ts apps/server/src/app.env.test.ts
git commit -m "fix(logging): redact WebSocket credentials"
```

### Task 8: Full Regression And Production Verification

- [ ] **Step 1: Run all server tests**

Run: `rtk pnpm --filter @loomic/server test`

Expected: all server Vitest suites PASS with zero unhandled rejections.

- [ ] **Step 2: Run all web and shared tests**

Run: `rtk pnpm --filter @loomic/shared test`

Expected: PASS.

Run: `rtk pnpm --filter @loomic/web test`

Expected: PASS.

- [ ] **Step 3: Run workspace typechecks**

Run: `rtk pnpm typecheck`

Expected: exit 0.

- [ ] **Step 4: Run production builds**

Run: `rtk pnpm build`

Expected: Turbo reports all package builds successful.

- [ ] **Step 5: Reproduce the original workflow**

Start the development server, submit an Agent prompt, and verify logs show context, acceptance, ACK, persistence, and first-event stages. Verify the ACK arrives before 15 seconds and the canvas operation completes. Repeat with a deliberately delayed acceptance adapter and confirm a correlated localized failure replaces `Failed to get response.` without a second run.

- [ ] **Step 6: Scan generated logs for credentials**

Run a bounded search using sentinel values from the regression test and verify no JWT, bearer token, Supabase key, or provider key is present. Do not print real secrets while performing the scan.
