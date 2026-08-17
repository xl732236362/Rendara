# Phase 2 Transaction Consistency, Job State Machine, and Canvas Revision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make generation submission, charging, queueing, job settlement, human compensation, Canvas writes, and post-commit events concurrency-safe and auditable.

**Architecture:** PostgreSQL RPCs own short atomic state changes. Generation submission uses a same-database transaction for idempotency, debit ledger, job creation, and PGMQ send; workers use lease-token conditional transitions around external calls. Canvas writers use revision compare-and-swap plus transactional outbox events, with inbox/effect receipts for at-least-once delivery.

**Tech Stack:** PostgreSQL/PLpgSQL, Supabase RLS and pgTAP, PGMQ, TypeScript, Zod 4, Fastify 5, Vitest 3, Next.js/React, Docker.

---

## File Map

- Create `supabase/migrations/20260818000000_phase2_job_status.sql`: commit the cooperative-cancellation enum extension before it is referenced.
- Create `supabase/migrations/20260818000001_phase2_consistency_and_canvas_revision.sql`: additive schema, constraints, indexes, hardened RPCs, outbox/inbox, and compatibility grants.
- Create `supabase/tests/phase_2_consistency.test.sql`: pgTAP permission, atomicity, idempotency, transition, compensation, Canvas CAS, and outbox tests.
- Create `apps/server/src/features/jobs/job-state-repository.ts`: typed Supabase RPC adapter for submit, cancel, claim, renew, and settle.
- Create `apps/server/src/features/jobs/job-state-repository.test.ts`: RPC result/error mapping and redaction tests.
- Create `apps/server/src/features/jobs/worker-job-lifecycle.ts`: transport-neutral message lifecycle around leases and terminal settlement.
- Create `apps/server/src/features/jobs/worker-job-lifecycle.test.ts`: duplicate delivery, stale lease, cancellation, retry, and queue acknowledgement tests.
- Create `apps/server/src/features/canvas/canvas-repository.ts`: Canvas read and revision-CAS RPC adapter.
- Create `apps/server/src/features/canvas/canvas-repository.test.ts`: CAS conflict/effect/outbox adapter tests.
- Create `apps/server/src/events/outbox-dispatcher.ts`: bounded `SKIP LOCKED` outbox delivery loop and acknowledgement adapter.
- Create `apps/server/src/events/outbox-dispatcher.test.ts`: publish retry and duplicate acknowledgement tests.
- Create `apps/server/src/testing/postgres-concurrency.test.ts`: real multi-session concurrency and failpoint suite, guarded by integration environment configuration.
- Create `apps/server/src/testing/database-test-env.ts`: validated integration database connection helper.
- Create `docs/tech/phase-2-operations-runbook.md`: deploy, monitor, replay, compensate, forward-fix, and rollback procedures.
- Create `docs/tech/phase-2-verification.md`: exact final acceptance evidence.
- Modify `packages/shared/src/job-contracts.ts`: new states, idempotency keys, lease/transition fields, cancellation result.
- Modify `packages/shared/src/contracts.ts`: Canvas revision in `CanvasDetail`.
- Modify `packages/shared/src/http.ts`: revision-aware Canvas save request/response and stable error codes.
- Modify `packages/shared/src/contracts.test.ts`: shared request/response/state contract tests.
- Modify `apps/server/src/application/generation/ports.ts`: replace split create/deduct/attach ports with one atomic submission command.
- Modify `apps/server/src/application/generation/submit-generation.ts`: validate and delegate one atomic submission after authorization/cost calculation.
- Modify `apps/server/src/application/generation/submit-generation.test.ts`: submission idempotency and no-compensation behavior.
- Modify `apps/server/src/features/jobs/job-service.ts`: retain query facade and delegate lifecycle mutations to repository.
- Modify `apps/server/src/features/jobs/generation-application-adapter.ts`: map atomic submission and `cancel_requested` outcomes.
- Modify `apps/server/src/features/jobs/queue-message.ts`: remove refund actions and classify terminal/claimable deliveries.
- Modify `apps/server/src/features/jobs/queue-message.test.ts`: prove rejected messages never refund.
- Modify `apps/server/src/worker.ts`: use lifecycle service, structured logs, lease renewal, and outbox dispatcher.
- Modify `apps/server/src/features/credits/credit-service.ts`: explicit human compensation API only.
- Modify `apps/server/src/features/canvas/canvas-service.ts`: return revision and commit via repository.
- Modify `apps/server/src/features/canvas/canvas-operation-application-adapter.ts`: bounded read/reapply/CAS retry.
- Modify `apps/server/src/features/canvas/generated-asset-application-adapter.ts`: stable effect key and unified repository.
- Modify `apps/server/src/features/canvas/canvas-element-writer.ts`: make element construction pure; remove direct database writes.
- Modify `apps/server/src/application/canvas/attach-generated-asset.ts`: require `effectKey`.
- Modify `apps/server/src/http/canvases.ts`: accept expected revision and return committed revision.
- Modify `apps/server/src/app.ts`: wire repositories, lifecycle service, and dispatcher.
- Modify `apps/web/src/lib/server-api.ts`: revision-aware fetch/save calls.
- Modify `apps/web/src/components/canvas-editor.tsx`: revision tracking, autosave pause, conflict UI, and revision-aware unload flush.
- Modify `tests/workspace.test.mjs`: prohibit legacy job mutations, automatic refunds, and direct Canvas content updates.
- Modify `docs/tech/engineering-issues-register.md`: close or update ENG-001/002/011/017 with evidence.
- Modify `README.md`: correct PGMQ delivery wording.

### Task 1: Shared Contracts and Error Vocabulary

**Files:**
- Modify: `packages/shared/src/job-contracts.ts`
- Modify: `packages/shared/src/contracts.ts`
- Modify: `packages/shared/src/http.ts`
- Modify: `packages/shared/src/contracts.test.ts`

- [x] **Step 1: Write failing contract tests**

Add assertions that `generationSubmissionRequestSchema` requires a 1-128 character `idempotency_key`, accepts `cancel_requested`, exposes lease metadata only on the job entity, and round-trips Canvas revisions:

```ts
expect(() => generationSubmissionRequestSchema.parse({
  type: "image_generation",
  prompt: "x",
})).toThrow();
expect(backgroundJobStatusSchema.parse("cancel_requested")).toBe("cancel_requested");
expect(canvasSaveRequestSchema.parse({
  expectedRevision: 3,
  content: { elements: [], appState: {} },
})).toMatchObject({ expectedRevision: 3 });
expect(canvasSaveResponseSchema.parse({ ok: true, revision: 4 })).toEqual({
  ok: true,
  revision: 4,
});
```

- [x] **Step 2: Run the shared contract tests and verify RED**

Run: `pnpm --filter @loomic/shared test -- --run`

Expected: FAIL because the current schemas have no idempotency key, `cancel_requested`, or revision fields.

- [x] **Step 3: Implement the contract changes**

Use one reusable key schema and safe integer revisions:

```ts
export const idempotencyKeySchema = z.string().trim().min(1).max(128);
export const canvasRevisionSchema = z.number().int().nonnegative().safe();
```

Extend every queued generation request with `idempotency_key`, extend `backgroundJobStatusSchema`, add `transition_version`, lease fields, `pgmq_message_id`, and credit identifiers to `backgroundJobSchema`, add `revision` to `canvasDetailSchema`, and define:

```ts
export const canvasSaveRequestSchema = z.object({
  content: canvasContentSchema,
  expectedRevision: canvasRevisionSchema,
});
export const canvasSaveResponseSchema = z.object({
  ok: z.literal(true),
  revision: canvasRevisionSchema,
});
```

Add `idempotency_conflict`, `invalid_job_transition`, `stale_job_lease`, `job_already_terminal`, `canvas_revision_conflict`, and `compensation_conflict` to the shared boundary error enum.

- [x] **Step 4: Run shared tests and typecheck**

Run: `pnpm --filter @loomic/shared test && pnpm --filter @loomic/shared typecheck`

Expected: PASS.

- [x] **Step 5: Commit**

```text
git add packages/shared/src/job-contracts.ts packages/shared/src/contracts.ts packages/shared/src/http.ts packages/shared/src/contracts.test.ts
git commit -m "feat(shared): define phase two consistency contracts"
```

### Task 2: Additive PostgreSQL Schema and Hardened RPCs

**Files:**
- Create: `supabase/migrations/20260818000000_phase2_consistency_and_canvas_revision.sql`
- Create: `supabase/tests/phase_2_consistency.test.sql`

- [x] **Step 1: Write failing pgTAP schema and permission tests**

Plan assertions for the new columns/tables, service-role-only submission/worker functions, authenticated cancel/Canvas functions, and revoked public execution. Submission stays server-only because model pricing is application-owned and must not be caller-supplied by a directly authenticated client. Include exact checks such as:

```sql
select has_column('public', 'canvases', 'revision', 'canvas revision exists');
select has_table('public', 'generation_submission_keys', 'submission keys exist');
select has_table('public', 'job_effect_receipts', 'effect receipts exist');
select has_table('public', 'domain_outbox', 'outbox exists');
select ok(not has_function_privilege('authenticated',
  'public.submit_generation_job(uuid,uuid,text,text,jsonb,integer,text)', 'execute'),
  'clients cannot bypass application-owned generation pricing');
select ok(not has_function_privilege('authenticated',
  'public.claim_generation_job(uuid,text,integer)', 'execute'),
  'clients cannot claim worker leases');
```

- [x] **Step 2: Run database tests and verify RED**

Run: `supabase test db`

Expected: FAIL because Phase 2 schema and functions do not exist.

- [x] **Step 3: Implement additive schema**

Create enums/columns and constraints without editing historical migrations. Add:

```sql
alter type public.background_job_status add value if not exists 'cancel_requested' after 'running';
alter table public.canvases add column revision bigint not null default 0 check (revision >= 0);
alter table public.background_jobs
  add column transition_version bigint not null default 0,
  add column lease_token uuid,
  add column lease_owner text,
  add column lease_expires_at timestamptz,
  add column pgmq_message_id bigint,
  add column idempotency_key text,
  add column request_fingerprint text;
```

Create `generation_submission_keys`, `job_effect_receipts`, `credit_compensations`, `domain_outbox`, and `domain_inbox` with primary/unique keys, foreign keys, bounded text/check constraints, timestamps, and RLS. Add partial indexes for expired active leases and unpublished outbox rows.

- [x] **Step 4: Implement hardened transactional functions**

Implement and comment these RPCs with fully qualified names, fixed `search_path`, explicit grants, stable SQLSTATE/detail codes, and consistent lock order. Grant `submit_generation_job` only to `service_role`; it accepts explicit user/workspace identities from the trusted server and revalidates membership plus referenced resource ownership in the database:

```text
public.submit_generation_job(...)
public.request_generation_cancellation(uuid)
public.claim_generation_job(uuid,text,integer)
public.renew_generation_job_lease(uuid,uuid,integer)
public.settle_generation_job(uuid,uuid,text,jsonb,text,text)
public.compensate_generation_charge(uuid,text,uuid,integer,text)
public.commit_canvas_revision(uuid,bigint,jsonb,text,text,jsonb)
public.claim_domain_outbox(integer,text)
public.ack_domain_outbox(uuid,text)
public.fail_domain_outbox(uuid,text,text)
```

`submit_generation_job` must call `pgmq.send` before returning and persist its message id. `settle_generation_job` must insert the success effect receipt before transitioning to succeeded. `commit_canvas_revision` must update Canvas, insert optional effect receipt, and insert outbox in one transaction.

- [x] **Step 5: Add pgTAP behavioral tests**

Use savepoints and deterministic fixtures to prove same-key replay, conflicting fingerprints, insufficient-balance rollback, one debit, immediate queued cancellation, running `cancel_requested`, stale lease rejection, terminal immutability, compensation replay, Canvas conflict, duplicate effect, and no outbox row after rollback.

- [x] **Step 6: Rebuild the database and run pgTAP**

Run: `supabase db reset --yes && supabase test db`

Expected: all migrations apply from zero and all pgTAP assertions pass.

- [x] **Step 7: Commit**

```text
git add supabase/migrations/20260818000000_phase2_job_status.sql supabase/migrations/20260818000001_phase2_consistency_and_canvas_revision.sql supabase/tests/phase_2_consistency.test.sql
git commit -m "feat(db): add transactional job and canvas primitives"
```

### Task 3: Atomic Generation Submission Application Boundary

**Files:**
- Create: `apps/server/src/features/jobs/job-state-repository.ts`
- Create: `apps/server/src/features/jobs/job-state-repository.test.ts`
- Modify: `apps/server/src/application/generation/ports.ts`
- Modify: `apps/server/src/application/generation/submit-generation.ts`
- Modify: `apps/server/src/application/generation/submit-generation.test.ts`
- Modify: `apps/server/src/features/jobs/generation-application-adapter.ts`
- Modify: `apps/server/src/features/jobs/job-service.ts`
- Modify: `apps/server/src/app.ts`

- [ ] **Step 1: Write failing application tests**

Replace split `create -> deduct -> attach` expectations with one `jobs.submit` call carrying cost and idempotency key. Assert same-key repository outcomes are returned unchanged, conflicting keys map to HTTP 409, and no cancellation/compensation runs after an atomic submission failure:

```ts
expect(ports.jobs.submit).toHaveBeenCalledWith(expect.objectContaining({
  idempotencyKey: "request-1",
  creditsCost: 7,
}));
expect(ports.credits?.deduct).toBeUndefined();
expect(ports.cancellation.cancel).not.toHaveBeenCalled();
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm --filter @loomic/server test -- src/application/generation/submit-generation.test.ts src/features/jobs/job-state-repository.test.ts`

Expected: FAIL because `jobs.submit` and the repository do not exist.

- [ ] **Step 3: Implement repository RPC mapping**

Define focused types and a single adapter:

```ts
export type AtomicSubmission = {
  job: BackgroundJob;
  debitTransactionId: string | null;
  replayed: boolean;
};
export type JobStateRepository = {
  submit(command: AtomicSubmissionCommand): Promise<AtomicSubmission>;
  requestCancellation(principal: GenerationPrincipal, jobId: string): Promise<BackgroundJob>;
};
```

Parse unknown RPC results with local Zod schemas. Map database detail codes to exposed `AppError`s. Hash key/fingerprint values before logging and never log payload/prompt/token.

- [ ] **Step 4: Simplify SubmitGeneration**

Keep model/tier/concurrency authorization and deterministic cost calculation, then call only `ports.jobs.submit`. Remove credit deduction, credit attachment, and cleanup cancellation branches from the queued submission path.

- [ ] **Step 5: Wire routes, Agent calls, and service queries**

Require or generate stable idempotency keys at every submit call site. HTTP accepts the explicit shared field; Agent tool calls derive a stable key from run/tool-call identity rather than random UUID per retry. Retain `JobService` query methods and delegate cancellation/submission mutations to `JobStateRepository`.

- [ ] **Step 6: Run focused and server tests**

Run: `pnpm --filter @loomic/server test -- src/application/generation/submit-generation.test.ts src/features/jobs/job-state-repository.test.ts src/features/jobs/generation-application-adapter.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```text
git add apps/server/src/application/generation apps/server/src/features/jobs/job-state-repository.ts apps/server/src/features/jobs/job-state-repository.test.ts apps/server/src/features/jobs/generation-application-adapter.ts apps/server/src/features/jobs/job-service.ts apps/server/src/app.ts apps/server/src/http apps/server/src/agent/runtime.ts
git commit -m "feat(server): submit generation atomically"
```

### Task 4: Lease-Aware Worker State Machine

**Files:**
- Create: `apps/server/src/features/jobs/worker-job-lifecycle.ts`
- Create: `apps/server/src/features/jobs/worker-job-lifecycle.test.ts`
- Modify: `apps/server/src/features/jobs/job-state-repository.ts`
- Modify: `apps/server/src/features/jobs/job-service.ts`
- Modify: `apps/server/src/features/jobs/queue-message.ts`
- Modify: `apps/server/src/features/jobs/queue-message.test.ts`
- Modify: `apps/server/src/worker.ts`

- [ ] **Step 1: Write state-machine tests first**

Cover claim rejection for terminal jobs, duplicate delivery, lease renewal, retryable failure, dead letter, `cancel_requested`, stale settlement, and crash after settle before message delete. Assert every rejection/refusal path never calls refund:

```ts
expect(await lifecycle.process(message)).toEqual({ disposition: "duplicate_terminal" });
expect(executor).not.toHaveBeenCalled();
expect(queue.deleteMsg).toHaveBeenCalledOnce();
expect(compensate).not.toHaveBeenCalled();
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm --filter @loomic/server test -- src/features/jobs/worker-job-lifecycle.test.ts src/features/jobs/queue-message.test.ts`

Expected: FAIL on the existing unconditional job updates and refund settlement.

- [ ] **Step 3: Implement the lifecycle service**

Use a per-delivery flow:

```ts
const claim = await jobs.claim(jobId, workerId, leaseSeconds);
if (claim.kind !== "claimed") return settleDuplicate(claim, message);
const renew = startLeaseRenewal(claim.leaseToken);
try {
  await jobs.assertExecutable(jobId, claim.leaseToken);
  const result = await executor(jobId, payload, context);
  const settled = await jobs.succeed(jobId, claim.leaseToken, result);
  return settled.kind === "succeeded" ? deleteMessage() : discardStaleResult();
} finally {
  renew.stop();
}
```

Cancellation checks occur before provider execution, after provider response, and inside the settlement RPC. Queue deletion/archive occurs only after durable terminal settlement.

- [ ] **Step 4: Remove automatic refunds**

Delete `refund` from queue settlement actions and remove `refundDeadLetteredJob` from `worker.ts`. Rejected, canceled, failed, and dead-lettered jobs preserve their original debit ledger.

- [ ] **Step 5: Replace console lifecycle logs**

Use a small structured logger adapter with event names, job/queue/message ids, attempt, worker id, lease digest, transition, duration, and stable error code. Do not log provider payloads or raw lease tokens.

- [ ] **Step 6: Run worker and queue tests**

Run: `pnpm --filter @loomic/server test -- src/features/jobs/worker-job-lifecycle.test.ts src/features/jobs/queue-message.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```text
git add apps/server/src/features/jobs apps/server/src/worker.ts
git commit -m "feat(worker): enforce leased generation state machine"
```

### Task 5: Explicit Human Compensation

**Files:**
- Modify: `apps/server/src/features/credits/credit-service.ts`
- Modify: `apps/server/src/features/credits/credit-service.test.ts`
- Modify: `apps/server/src/http/credits.ts`
- Modify: `apps/server/src/http/credits.test.ts`

- [ ] **Step 1: Write failing compensation tests**

Assert the service requires `compensationKey`, original debit/job, operator, amount, and reason; same replay returns the original transaction; conflicting replay maps to `compensation_conflict`; no generic job failure path can call it.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm --filter @loomic/server test -- src/features/credits/credit-service.test.ts src/http/credits.test.ts`

Expected: FAIL because the current refund method has no compensation identity or operator audit.

- [ ] **Step 3: Replace generic refund API**

Expose only:

```ts
compensateGeneration(command: {
  workspaceId: string;
  jobId: string;
  debitTransactionId: string;
  compensationKey: string;
  operatorUserId: string;
  amount: number;
  reason: string;
}): Promise<{ transactionId: string; replayed: boolean }>;
```

Call `compensate_generation_charge` and parse/map its result. Keep the endpoint behind the existing administrative authority boundary; do not expose it as ordinary job cancellation.

- [ ] **Step 4: Run tests and search for legacy refunds**

Run: `pnpm --filter @loomic/server test -- src/features/credits src/http/credits.test.ts`

Run: `rg -n "refundCredits|refund_credits|Auto-refund" apps/server/src`

Expected: tests PASS; search returns no automatic lifecycle invocation.

- [ ] **Step 5: Commit**

```text
git add apps/server/src/features/credits apps/server/src/http/credits.ts apps/server/src/http/credits.test.ts
git commit -m "feat(credits): add replay-safe human compensation"
```

### Task 6: Canvas Revision Repository and Unified Server Writers

**Files:**
- Create: `apps/server/src/features/canvas/canvas-repository.ts`
- Create: `apps/server/src/features/canvas/canvas-repository.test.ts`
- Modify: `apps/server/src/features/canvas/canvas-service.ts`
- Modify: `apps/server/src/features/canvas/canvas-service.test.ts`
- Modify: `apps/server/src/features/canvas/canvas-operation-application-adapter.ts`
- Modify: `apps/server/src/features/canvas/canvas-operation-application-adapter.test.ts`
- Modify: `apps/server/src/features/canvas/generated-asset-application-adapter.ts`
- Modify: `apps/server/src/features/canvas/canvas-element-writer.ts`
- Modify: `apps/server/src/application/canvas/attach-generated-asset.ts`
- Modify: `apps/server/src/application/canvas/attach-generated-asset.test.ts`
- Modify: `apps/server/src/app.ts`

- [ ] **Step 1: Write failing Canvas repository and retry tests**

Test successful revision 3 -> 4 commit, expected/current conflict details, three-operation retries, no retry for full-document save, duplicate generated asset effect, and event identity:

```ts
await expect(repository.commit({ expectedRevision: 3, ...command }))
  .resolves.toMatchObject({ revision: 4, replayed: false });
await expect(repository.commit({ expectedRevision: 2, ...command }))
  .rejects.toMatchObject({ code: "canvas_revision_conflict", statusCode: 409 });
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm --filter @loomic/server test -- src/features/canvas/canvas-repository.test.ts src/features/canvas/canvas-operation-application-adapter.test.ts`

Expected: FAIL because writes do not carry revisions.

- [ ] **Step 3: Implement CanvasRepository**

Define `read` returning stored content plus revision and `commit` calling `commit_canvas_revision`. Parse RPC output and map conflict details. Keep Storage upload outside `commit` and log orphan candidates when CAS exhausts retries.

- [ ] **Step 4: Make element writer pure**

Change image/video helpers to accept `CanvasContent` and return `{ content, elementId }`; remove all `.from("canvases")` reads/updates. Preserve storage download as an explicit pre-commit preparation step for image content.

- [ ] **Step 5: Route Agent and generated assets through CAS**

`applyOperations` performs read -> pure apply -> commit and retries at most three conflicts with bounded jitter. `AttachGeneratedAssetCommand` requires a stable `effectKey` derived from job/effect identity and uses the same repository path.

- [ ] **Step 6: Run all Canvas server tests**

Run: `pnpm --filter @loomic/server test -- src/features/canvas src/application/canvas`

Expected: PASS.

- [ ] **Step 7: Commit**

```text
git add apps/server/src/features/canvas apps/server/src/application/canvas apps/server/src/app.ts
git commit -m "feat(canvas): enforce revision checked server writes"
```

### Task 7: Revision-Aware HTTP and Browser Conflict UX

**Files:**
- Modify: `apps/server/src/http/canvases.ts`
- Modify: `apps/server/src/http/route-error-migration.test.ts`
- Modify: `apps/web/src/lib/server-api.ts`
- Modify: `apps/web/src/lib/server-api.test.ts`
- Modify: `apps/web/src/components/canvas-editor.tsx`
- Create: `apps/web/src/components/canvas-editor.revision.test.tsx`

- [ ] **Step 1: Write failing HTTP/client tests**

Assert PUT requires `expectedRevision`, returns `{ ok: true, revision }`, maps repository conflicts to 409 with safe revision details, and `saveCanvas` parses the response rather than using empty mode.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm --filter @loomic/server test -- src/http/route-error-migration.test.ts && pnpm --filter @loomic/web test -- src/lib/server-api.test.ts src/components/canvas-editor.revision.test.tsx`

Expected: FAIL because the current endpoint has no revision protocol.

- [ ] **Step 3: Implement the HTTP and API client contract**

Pass `payload.expectedRevision` to `CanvasService.saveCanvasContent` and return the committed revision. Change the web API to:

```ts
export function saveCanvas(token: string, canvasId: string,
  expectedRevision: number, content: CanvasContent) {
  return apiFetch({
    method: "PUT",
    path: `/api/canvases/${canvasId}`,
    accessToken: token,
    requestSchema: canvasSaveRequestSchema,
    body: { expectedRevision, content },
    responseSchema: canvasSaveResponseSchema,
  });
}
```

- [ ] **Step 4: Implement browser revision tracking**

Initialize a `revisionRef` from `CanvasDetail.revision`. Capture the expected revision with each debounced payload, serialize saves, and advance only from a parsed successful response. On `canvas_revision_conflict`, pause autosave, retain the unsaved payload, show an accessible non-overlapping conflict banner with Reload and Dismiss actions, and never retry stale whole content.

The unload request includes the last known expected revision. It remains best effort and never advances local revision without a response.

- [ ] **Step 5: Run focused tests**

Run: `pnpm --filter @loomic/server test -- src/http/route-error-migration.test.ts && pnpm --filter @loomic/web test -- src/lib/server-api.test.ts src/components/canvas-editor.revision.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

```text
git add apps/server/src/http apps/web/src/lib/server-api.ts apps/web/src/lib/server-api.test.ts apps/web/src/components/canvas-editor.tsx apps/web/src/components/canvas-editor.revision.test.tsx
git commit -m "feat(web): surface canvas revision conflicts"
```

### Task 8: Transactional Outbox Dispatcher

**Files:**
- Create: `apps/server/src/events/outbox-dispatcher.ts`
- Create: `apps/server/src/events/outbox-dispatcher.test.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/worker.ts`
- Modify: `apps/server/src/ws/event-buffer.ts`

- [ ] **Step 1: Write failing dispatcher tests**

Test bounded claims, publish then ack, publish failure then fail/backoff, crash-after-publish duplicate delivery, and event-id inbox deduplication. Use fake timers without sleeping.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm --filter @loomic/server test -- src/events/outbox-dispatcher.test.ts`

Expected: FAIL because no dispatcher exists.

- [ ] **Step 3: Implement one-shot and loop APIs**

Expose a deterministic unit:

```ts
export async function dispatchOutboxBatch(deps: OutboxDependencies): Promise<{
  claimed: number;
  published: number;
  failed: number;
}>;
```

Claim rows through the RPC, publish to the existing Canvas event adapter, then ack. On failure call the fail RPC with a sanitized error code. The loop uses an abort signal and bounded idle delay; shutdown waits for the active batch.

- [ ] **Step 4: Wire only the current in-process event adapter**

Start the dispatcher in the appropriate long-running process without introducing Redis, shared WebSocket state, CRDT, or Phase 5 replay infrastructure. Ensure direct pre-commit Canvas publication is removed.

- [ ] **Step 5: Run dispatcher and WebSocket tests**

Run: `pnpm --filter @loomic/server test -- src/events src/ws`

Expected: PASS.

- [ ] **Step 6: Commit**

```text
git add apps/server/src/events apps/server/src/app.ts apps/server/src/worker.ts apps/server/src/ws/event-buffer.ts
git commit -m "feat(events): publish committed domain outbox events"
```

### Task 9: Architecture Enforcement and Real Concurrency/Fault Tests

**Files:**
- Create: `apps/server/src/testing/database-test-env.ts`
- Create: `apps/server/src/testing/postgres-concurrency.test.ts`
- Modify: `apps/server/package.json`
- Modify: `tests/workspace.test.mjs`
- Modify: `README.md`

- [ ] **Step 1: Add failing architecture fixtures**

Extend the TypeScript AST scanner to reject server code outside repositories that calls `.update({ content: ... })`, direct `background_jobs` lifecycle updates, or generation failure/cancellation paths invoking compensation. Add one negative fixture per bypass and scan real source.

- [ ] **Step 2: Run workspace tests and verify RED**

Run: `pnpm test:workspace`

Expected: FAIL on the legacy direct writers until Tasks 3-8 have removed them and the scanner allowlist is precise.

- [ ] **Step 3: Add real PostgreSQL test harness**

Validate `PHASE2_TEST_DATABASE_URL`, create independent `pg.Pool` clients, and provide barrier helpers that use promises/advisory locks rather than timing sleeps. Add `test:integration` to the server package without folding environment-dependent tests into ordinary unit tests.

- [ ] **Step 4: Implement concurrency matrix**

Use two or more independent sessions to prove: identical/conflicting submission races, balance contention, simultaneous lease claims, lease expiry takeover, stale settlement, cancel/succeed serialization, compensation replay, Canvas CAS races, effect receipt uniqueness, and outbox rollback. Assert exact row counts, balance, ledger entries, job state/version, Canvas revision, effect count, and outbox count.

- [ ] **Step 5: Implement named failpoints**

The test-only session setting `loomic.test_failpoint` is read by Phase 2 RPCs only when the database role is the local test owner. Exercise `after_debit`, `before_enqueue`, `before_job_settle_commit`, `before_canvas_commit`, and `after_outbox_claim`. Production roles cannot activate failpoints.

- [ ] **Step 6: Correct queue documentation**

Replace any claim of unconditional PGMQ exactly-once delivery with: one consumer within a visibility timeout; messages become visible again when not deleted/archived; Loomic business handling is at least once and idempotent.

- [ ] **Step 7: Run architecture and integration tests**

Run: `pnpm test:workspace`

Run: `pnpm --filter @loomic/server test:integration`

Expected: both PASS against the rebuilt local database.

- [ ] **Step 8: Commit**

```text
git add apps/server/src/testing apps/server/package.json tests/workspace.test.mjs README.md
git commit -m "test: prove phase two concurrency invariants"
```

### Task 10: Operations, Governance, and Acceptance Evidence

**Files:**
- Create: `docs/tech/phase-2-operations-runbook.md`
- Create: `docs/tech/phase-2-verification.md`
- Modify: `docs/tech/engineering-issues-register.md`

- [ ] **Step 1: Write the operations runbook**

Document expand/backfill/switch/enforce deployment order, schema-compatible application rollback, forward-fix rules, metrics/alerts, and exact diagnostic queries for stuck queued jobs, expired leases, repeated reads, unpublished outbox age, Canvas conflicts, orphan Storage candidates, and compensation audit. Include safe event replay and human compensation commands with pre/post verification.

- [ ] **Step 2: Update the issue register**

Mark ENG-001/002/011 resolved only with exact implementation commits and test evidence. Mark ENG-017 resolved if the architecture scanner proves no direct Canvas write bypass remains; otherwise record the exact remaining bounded path and keep it partially solved.

- [ ] **Step 3: Run the complete quality gate**

Run:

```text
pnpm test:workspace
pnpm exec turbo run test --force
pnpm ci:check
pnpm exec turbo run typecheck --force
pnpm exec turbo run build --force
```

Expected: all commands return 0 with no cached package test/typecheck/build claims where `--force` is used.

- [ ] **Step 4: Run database zero rebuild, permissions, concurrency, and fault tests**

Run:

```text
supabase start
supabase db reset --yes
supabase test db
pnpm --filter @loomic/server test:integration
```

Expected: fresh migration application and every permission/concurrency/failpoint assertion PASS.

- [ ] **Step 5: Validate production Docker entrypoints**

Run:

```text
docker build -f apps/server/Dockerfile -t loomic-server:phase2 .
docker run --rm --entrypoint node loomic-server:phase2 -e "import('./dist/app.js').then(() => console.log('app-load-ok'))"
docker run --rm --entrypoint sh loomic-server:phase2 -c "test -r dist/server.js && node --check dist/server.js"
docker run --rm --entrypoint sh loomic-server:phase2 -c "test -r dist/worker.js && node --check dist/worker.js"
```

Expected: image builds, application module prints `app-load-ok`, and both production entrypoints pass syntax/load checks. Where configuration permits safe startup, start API and Worker containers and record readiness/process evidence without claiming external-provider success.

- [ ] **Step 6: Perform diff and scope audit**

Run:

```text
git diff --check
git status --short
git diff <phase-2-baseline>...HEAD --stat
rg -n "refundDeadLetteredJob|Auto-refund|\.update\(\{ content" apps/server/src
```

Expected: no whitespace errors, only intended Phase 2 files, no automatic refunds, and no direct Canvas persistence bypass.

- [ ] **Step 7: Write exact verification evidence**

Record commit ids, host/tool versions, exact commands, test counts, database reset/pgTAP/integration results, Docker image id, known limits, and any forward-fix note in `phase-2-verification.md`. Do not generalize a narrow check into a broader production claim.

- [ ] **Step 8: Commit governance evidence**

```text
git add docs/tech/phase-2-operations-runbook.md docs/tech/phase-2-verification.md docs/tech/engineering-issues-register.md
git commit -m "docs(governance): record phase two acceptance"
```

### Task 11: Independent Review and Final Re-Verification

**Files:**
- Modify only files required by confirmed review findings.

- [ ] **Step 1: Review against the design and issue register**

Inspect every legal/illegal transition, debit/compensation unique key, lease predicate, result/effect receipt, Canvas writer, outbox publish boundary, RPC privilege, RLS policy, failpoint guard, and Phase 3-5 non-goal. Findings must include exact file/line evidence and severity.

- [ ] **Step 2: Write a failing regression test for each confirmed defect**

For every correctness finding, add the narrowest unit, pgTAP, or real-concurrency test that reproduces it and run that test to prove RED before changing implementation.

- [ ] **Step 3: Fix confirmed defects and rerun focused tests**

Implement only evidence-backed corrections, run each new regression test to GREEN, and commit coherent fixes with messages naming the invariant restored.

- [ ] **Step 4: Repeat all final gates from Task 10**

Re-run quality, forced test/typecheck/build, zero database rebuild, pgTAP, real concurrency/fault injection, Docker entrypoints, `git diff --check`, and scope searches on the final reviewed commit.

- [ ] **Step 5: Update verification evidence and stop before merge/push**

Record final commit and rerun evidence in `phase-2-verification.md`. Confirm the worktree is clean. Do not merge or push `main` unless the user separately requests it.
