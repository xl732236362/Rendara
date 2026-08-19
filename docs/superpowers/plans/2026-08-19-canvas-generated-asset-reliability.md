# Canvas Generated Asset Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make generated image/video attachment durable and exactly-once, stop no-op canvas revision churn, preserve unsaved local edits during server synchronization, and guarantee every Agent run terminates or is durably recovered.

**Architecture:** A browser persistence coordinator owns canonical canvas fingerprints, serialized saves, remote synchronization, and constrained append-only merging. Agent generation submission atomically reserves a durable attachment intent; a worker reconciler fulfills it through a row-locked incremental database RPC whose receipt is the idempotency boundary. Shared result contracts, authenticated recovery endpoints, phase-aware deadlines, renewable attempt leases, and expired-run recovery keep the UI and persisted run state truthful across process and network failure.

**Tech Stack:** TypeScript, React 19, Next.js 15, Excalidraw 0.18, LangChain 1.2 / `@langchain/core` 1.1, Fastify 5, Supabase Postgres/PostgREST, pgTAP, Vitest, Playwright.

---

## File Map

- `packages/shared/src/artifacts.ts`: bounded generated-media artifact and attachment recovery schemas.
- `packages/shared/src/events.ts`: additive `tool.failed` recovery/artifact wire fields.
- `packages/shared/src/contracts.ts`: persisted failed tool blocks and attachment state.
- `packages/shared/src/job-contracts.ts`: authenticated attachment status/list/retry response schemas.
- `apps/web/src/lib/canvas-persistence.ts`: canonical durable payload, fingerprint, dirty hint, save state machine, and append-only merge.
- `apps/web/src/lib/canvas-sync-coordinator.ts`: compatibility facade over the unified persistence coordinator.
- `apps/web/src/components/canvas-editor.tsx`: Excalidraw adapter, durable-change notification, conflict UI, and acknowledged thumbnail scheduling.
- `apps/web/src/app/canvas/page.tsx`: sync/reconnect/focus/terminal-run triggers routed through the editor-owned coordinator.
- `apps/web/src/lib/server-api.ts`: attachment status/list/retry calls.
- `apps/web/src/hooks/use-chat-stream.ts`, `apps/web/src/hooks/use-chat-sessions.ts`: preserve failed recovery metadata.
- `apps/web/src/components/chat/tool-block-view.tsx`, `apps/web/src/components/chat-sidebar.tsx`: pending/not-attached status and retry UI; remove Agent artifact insertion callbacks.
- `supabase/migrations/20260819000003_canvas_generated_asset_reliability.sql`: intent/recovery tables, claim/settle/fulfill RPCs, attempt renewal, expired-run recovery, constraints, indexes, and grants.
- `supabase/tests/canvas_generated_asset_reliability.test.sql`: transaction, fencing, replay, recovery, and concurrency coverage.
- `apps/server/src/application/generation/ports.ts`, `submit-generation.ts`: private Agent attachment context and fail-closed submission.
- `apps/server/src/features/jobs/job-state-repository.ts`, `generation-application-adapter.ts`: atomic job/intent submission adapter.
- `apps/server/src/application/canvas/attach-generated-asset.ts`: authenticated status/retry use cases and internal fulfillment command.
- `apps/server/src/features/canvas/generated-asset-attachment-repository.ts`: typed attachment-intent/RPC repository.
- `apps/server/src/features/canvas/generated-asset-application-adapter.ts`: trusted job/asset template derivation.
- `apps/server/src/features/canvas/generated-asset-attachment-reconciler.ts`: durable claim/backoff/fulfillment loop.
- `apps/server/src/features/jobs/worker-job-lifecycle.ts`, `apps/server/src/worker.ts`: settlement wakeup and periodic intent/run recovery scans.
- `apps/server/src/agent/generated-media-result.ts`: discriminated tool result and typed attachment error.
- `apps/server/src/agent/tools/image-generate.ts`, `video-generate.ts`: LangChain `content_and_artifact` returns.
- `apps/server/src/agent/tool-governance-middleware.ts`, `tool-lifecycle.ts`, `stream-adapter.ts`: safe failure projection.
- `apps/server/src/agent/run-deadlines.ts`: model inactivity, tool, overall deadline, abort, and iterator cleanup.
- `apps/server/src/features/agent-runs/agent-execution-repository.ts`, `apps/server/src/agent/runtime.ts`: lease renewal and fencing.
- `apps/server/src/http/jobs.ts`, `apps/server/src/app.ts`, `apps/server/src/events/domain-event-publisher.ts`: recovery routes, readiness, and recovered terminal delivery.

### Task 1: Add Bounded Shared Recovery Contracts

**Files:**
- Modify: `packages/shared/src/artifacts.ts`
- Modify: `packages/shared/src/events.ts`
- Modify: `packages/shared/src/contracts.ts`
- Modify: `packages/shared/src/job-contracts.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/artifacts.test.ts`
- Test: `packages/shared/src/contracts.test.ts`

- [ ] **Step 1: Write failing schema tests**

Add tests proving the public contract accepts only the two recovery kinds, requires UUID-like job/canvas identity, bounds error text and artifact arrays, rejects data/file URLs, and persists failed tool activities:

```ts
expect(toolFailedEventSchema.parse({
  type: "tool.failed",
  runId: "run-1",
  toolCallId: "tool-1",
  toolName: "generate_image",
  error: { code: "generated_asset_not_attached", message: "Generated but not attached.", correlationId: "corr-1" },
  recovery: { kind: "attach_generated_asset", jobId: ids.job, canvasId: ids.canvas },
  artifacts: [safeImageArtifact],
  timestamp,
})).toMatchObject({ recovery: { kind: "attach_generated_asset" } });

expect(toolBlockSchema.parse({
  type: "tool",
  toolCallId: "tool-1",
  toolName: "generate_image",
  status: "failed",
  error: { code: "generated_asset_not_attached", message: "Generated but not attached.", correlationId: "corr-1" },
  recovery: { kind: "attach_generated_asset", jobId: ids.job, canvasId: ids.canvas },
})).toMatchObject({ status: "failed" });
```

- [ ] **Step 2: Run the shared tests and verify RED**

Run: `pnpm --filter @loomic/shared test`

Expected: FAIL because failed tool status and recovery fields are not defined.

- [ ] **Step 3: Implement strict additive contracts**

Export these exact schema families and inferred types:

```ts
export const generatedAssetRecoverySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("attach_generated_asset"), jobId: z.string().uuid(), canvasId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("watch_generated_asset"), jobId: z.string().uuid(), canvasId: z.string().uuid() }).strict(),
]);

export const generatedAssetAttachmentStatusSchema = z.discriminatedUnion("attachmentStatus", [
  z.object({ attachmentStatus: z.literal("attached"), jobId: z.string().uuid(), elementId: z.string().min(1), canvasRevision: z.number().int().positive() }),
  z.object({ attachmentStatus: z.literal("not_requested"), jobId: z.string().uuid() }),
  z.object({ attachmentStatus: z.literal("pending"), jobId: z.string().uuid(), recovery: generatedAssetRecoverySchema, error: generatedAssetErrorSchema }),
  z.object({ attachmentStatus: z.literal("not_attached"), jobId: z.string().uuid(), recovery: generatedAssetRecoverySchema, error: generatedAssetErrorSchema }),
]);
```

Use `.url().refine(url => url.startsWith("https://") || url.startsWith("/api/assets/"))` for display URLs. Add optional `recovery` and max-10 `artifacts` to failed events and persisted tool blocks; add `status: "failed"` plus bounded public `error`. Define status/list/retry HTTP response schemas in `job-contracts.ts` and export them from `index.ts`.

- [ ] **Step 4: Run shared tests and typecheck**

Run: `pnpm --filter @loomic/shared test && pnpm --filter @loomic/shared typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src
git commit -m "feat(shared): add generated asset recovery contracts"
```

### Task 2: Build the Canonical Browser Persistence Coordinator

**Files:**
- Modify: `apps/web/src/lib/canvas-persistence.ts`
- Modify: `apps/web/src/lib/canvas-sync-coordinator.ts`
- Test: `apps/web/test/canvas-editor-persistence.test.tsx`
- Test: `apps/web/test/canvas-sync-coordinator.test.ts`

- [ ] **Step 1: Write failing coordinator tests**

Cover canonical object-key ordering, omitted `undefined`, array-order preservation, persisted app-state filtering, no-op suppression, mutation during an in-flight save, ambiguous-outcome readback, unload behavior, duplicate/out-of-order sync, and append-only merge:

```ts
const coordinator = createCanvasPersistenceCoordinator({
  initial: { revision: 4, content: base },
  save: saveDeferred.fn,
  fetch: fetchCanvas,
  applyRemote,
  onConflict,
  onCommitted,
});

await coordinator.observe({ ...base, appState: { ...base.appState, selectedElementIds: { a: true } } });
expect(saveDeferred.fn).not.toHaveBeenCalled();

const first = coordinator.observe(localA);
await saveDeferred.started;
const second = coordinator.observe(localB);
saveDeferred.resolve({ revision: 5 });
await first;
expect(saveDeferred.fn).toHaveBeenNthCalledWith(2, expect.objectContaining({ content: localB, expectedRevision: 5 }));
await second;
```

Add merge tests where a remote-only generated element/file is appended to dirty local content, and where a changed/reordered base element or ID collision calls `onConflict` without applying or saving.

- [ ] **Step 2: Run focused Web tests and verify RED**

Run: `pnpm --filter @loomic/web exec vitest run test/canvas-editor-persistence.test.tsx test/canvas-sync-coordinator.test.ts`

Expected: FAIL because canonical fingerprints and unified save/sync states do not exist.

- [ ] **Step 3: Implement canonicalization and coordinator state**

Add `normalizeDurableCanvasContent`, `canonicalJson`, `fingerprintCanvasContent`, `createCanvasDirtySignature`, `mergeAppendOnlyRemoteContent`, and `createCanvasPersistenceCoordinator`. Its state is exact and immutable:

```ts
type Snapshot = { revision: number; content: CanvasContent; fingerprint: string };
type CoordinatorState = {
  base: Snapshot;
  pending: Omit<Snapshot, "revision"> | null;
  inFlight: Omit<Snapshot, "revision"> | null;
  live: Omit<Snapshot, "revision">;
};
```

Serialize `observe`, save acknowledgements, remote sync, and ambiguous readback through one promise queue. The save call always receives the revision paired with `base.content`; `syncToRevision` fetches current authoritative content and either applies it or performs only the design-approved append merge. Keep `createCanvasSyncCoordinator` as a small adapter so current callers compile while Task 3 migrates them.

- [ ] **Step 4: Run focused Web tests and verify GREEN**

Run: `pnpm --filter @loomic/web exec vitest run test/canvas-editor-persistence.test.tsx test/canvas-sync-coordinator.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/canvas-persistence.ts apps/web/src/lib/canvas-sync-coordinator.ts apps/web/test/canvas-editor-persistence.test.tsx apps/web/test/canvas-sync-coordinator.test.ts
git commit -m "feat(web): coordinate durable canvas persistence"
```

### Task 3: Route Excalidraw Saves and Sync Through One Coordinator

**Files:**
- Modify: `apps/web/src/components/canvas-editor.tsx`
- Modify: `apps/web/src/app/canvas/page.tsx`
- Test: `apps/web/test/canvas-editor-persistence.test.tsx`
- Test: `apps/web/test/canvas-image-generation.test.tsx`

- [ ] **Step 1: Add failing integration-style component tests**

Assert that repeated identical `onChange`, selection, viewport, and remote echo callbacks produce zero saves/thumbnail uploads; one durable change produces one save and then one thumbnail; sync preserves unsaved local edits; and unload sends nothing without a real pending fingerprint.

```ts
excalidrawProps.onChange(elements, { viewBackgroundColor: "#fff", scrollX: 0 });
excalidrawProps.onChange(elements, { viewBackgroundColor: "#fff", scrollX: 300 });
await vi.advanceTimersByTimeAsync(2_000);
expect(saveCanvas).not.toHaveBeenCalled();
expect(uploadThumbnail).not.toHaveBeenCalled();
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm --filter @loomic/web exec vitest run test/canvas-editor-persistence.test.tsx test/canvas-image-generation.test.tsx`

Expected: FAIL because `onChange` currently creates placeholder pending payloads and schedules every save/thumbnail.

- [ ] **Step 3: Replace editor-local revision/save state**

Instantiate one coordinator per canvas after hydration. `handleChange` updates selection immediately but only passes a dirty hint to the coordinator after debounce. The coordinator owns revision, suppression, pending payload, save serialization, conflict transition, and remote application. Schedule thumbnail generation exclusively from `onCommitted`. Expose this handle:

```ts
export type CanvasPersistenceHandle = {
  mutate: DurableSceneMutation;
  sync(request: { eventId: string; revision: number }): Promise<void>;
  reconcile(reason: "focus" | "reconnect" | "run_terminal"): Promise<void>;
};
```

Update `page.tsx` to forward `canvas.sync`, focus, reconnect, and terminal-run triggers to the handle. Remove direct `fetchCanvas` plus `api.updateScene` synchronization. Register remote files before scene update under autosave suppression. Keep the existing visible conflict banner and add structured `console` fields without canvas content or URLs.

- [ ] **Step 4: Verify Web persistence behavior**

Run: `pnpm --filter @loomic/web test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/canvas-editor.tsx apps/web/src/app/canvas/page.tsx apps/web/test
git commit -m "fix(web): suppress no-op canvas saves and merge sync"
```

### Task 4: Add Durable Attachment Intent and Incremental Fulfillment SQL

**Files:**
- Create: `supabase/migrations/20260819000003_canvas_generated_asset_reliability.sql`
- Create: `supabase/tests/canvas_generated_asset_reliability.test.sql`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Write failing pgTAP tests**

Create tests for table constraints/RLS/grants, atomic job+intent submission, claim fencing, retry backoff/exhaustion, cancellation/dead-letter settlement, authenticated recovery, exact-once fulfillment, browser-save concurrency, replay after movement/deletion, ID collision, scope/media/asset mismatch, stale Agent fence, expired run recovery, and resume/recovery races.

```sql
select is(
  (select count(*) from public.job_effect_receipts where job_id = :'job_id' and effect_kind = 'generated_asset_attached'),
  1::bigint,
  'duplicate fulfillment writes one receipt'
);
select is((select revision from public.canvases where id = :'canvas_id'), 2::bigint, 'attachment advances revision once');
select is((select count(*) from public.domain_event_outbox where aggregate_id = :'canvas_id' and event_type = 'canvas.generated_asset_attached'), 1::bigint, 'one outbox event');
```

- [ ] **Step 2: Run database tests and verify RED**

Run: `supabase test db supabase/tests/canvas_generated_asset_reliability.test.sql`

Expected: FAIL because the tables and RPCs do not exist.

- [ ] **Step 3: Implement schema and RPCs**

Create `generated_asset_attachment_intents` with states `pending`, `running`, `retry_wait`, `attached`, `failed`, `canceled`; unique `(job_id, effect_kind)`; immutable scope fields; placement policy; claim owner/expiry/fence; max eight attempts; bounded public error code; and attached result. Create `generated_asset_recovery_audits` unique on `(user_id, canvas_id, job_id, effect_kind)`.

Implement service-role-only functions:

```sql
submit_generation_job(..., p_attachment_intent jsonb default null)
claim_generated_asset_attachment_intents(p_worker_id text, p_limit integer, p_lease_seconds integer, p_now timestamptz)
retry_generated_asset_attachment(p_user_id uuid, p_canvas_id uuid, p_job_id uuid)
settle_generated_asset_attachment_intent(p_intent_id uuid, p_claim_fence bigint, p_outcome text, p_error_code text, p_next_attempt_at timestamptz)
fulfill_generated_asset_attachment(p_intent_id uuid, p_claim_fence bigint, p_element_template jsonb, p_file_template jsonb, p_agent_attempt_id uuid, p_agent_fencing_token bigint)
renew_agent_run_attempt(p_attempt_id uuid, p_fencing_token bigint, p_lease_owner text, p_lease_ms integer)
recover_expired_agent_runs(p_now timestamptz, p_grace_ms integer, p_limit integer)
```

`fulfill_generated_asset_attachment` locks job, intent, canvas, receipt/effect/audit in that order; derives final `auto_right` coordinates against locked content; appends one deterministic job-ID element and optional `${job_id}-file`; increments revision once; inserts receipt/outbox; completes intent/audit; and completes the Agent effect only if its optional fence remains active. Receipt replay returns its stored original result without inspecting current element/file existence.

- [ ] **Step 4: Run database tests from clean and upgraded states**

Run: `supabase db reset && supabase test db supabase/tests/canvas_generated_asset_reliability.test.sql && supabase test db`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260819000003_canvas_generated_asset_reliability.sql supabase/tests/canvas_generated_asset_reliability.test.sql .github/workflows/ci.yml
git commit -m "feat(db): add durable generated asset attachment"
```

### Task 5: Make Agent Generation Submission Create Intent Atomically

**Files:**
- Modify: `apps/server/src/application/generation/ports.ts`
- Modify: `apps/server/src/application/generation/submit-generation.ts`
- Modify: `apps/server/src/features/jobs/job-state-repository.ts`
- Modify: `apps/server/src/features/jobs/generation-application-adapter.ts`
- Modify: `apps/server/src/agent/runtime.ts`
- Test: `apps/server/src/application/generation/submit-generation.test.ts`
- Test: `apps/server/src/features/jobs/job-state-repository.test.ts`
- Test: `apps/server/src/features/jobs/generation-application-adapter.test.ts`
- Test: `apps/server/src/agent/runtime.application-wiring.test.ts`

- [ ] **Step 1: Add failing submission tests**

Define a private `AgentAttachmentContext` accepted only by the internal `SubmitGeneration` call and assert it reaches the single database submission RPC:

```ts
await submitGeneration(principal, publicRequest, {
  runId: ids.run,
  attemptId: ids.attempt,
  fencingToken: 7,
  logicalToolCallId: "tool-1",
  inputDigest: "sha256",
  effectKind: "generated_asset_attached",
  mediaType: "image",
  placement: { kind: "auto_right" },
});
expect(jobPort.submit).toHaveBeenCalledWith(expect.objectContaining({ attachmentIntent: expect.objectContaining({ fencingToken: 7 }) }));
```

Assert a canvas-mutating request fails before `jobs.submit` when intent infrastructure readiness is false, while public/direct generation submits without an Agent intent.

- [ ] **Step 2: Run focused server tests and verify RED**

Run: `pnpm --filter @loomic/server exec vitest run src/application/generation/submit-generation.test.ts src/features/jobs/job-state-repository.test.ts src/features/jobs/generation-application-adapter.test.ts src/agent/runtime.application-wiring.test.ts`

Expected: FAIL because submission has no private intent context.

- [ ] **Step 3: Implement internal intent propagation**

Change the function type to:

```ts
export type SubmitGeneration = (
  principal: GenerationPrincipal,
  request: unknown,
  attachment?: AgentAttachmentContext,
) => Promise<GenerationSubmissionResponse>;
```

Validate allowlisted effect kind, media type, current attempt fence, and explicit placement before calling the adapter. Add the bounded intent JSON to `submit_generation_job`; never add these fields to `generationSubmissionRequestSchema` or HTTP bodies. Runtime reserves the Agent effect first and supplies the current attempt context. Readiness failure maps to a private 503 and occurs before billing/job creation.

- [ ] **Step 4: Run focused tests and server typecheck**

Run: `pnpm --filter @loomic/server exec vitest run src/application/generation/submit-generation.test.ts src/features/jobs/job-state-repository.test.ts src/features/jobs/generation-application-adapter.test.ts src/agent/runtime.application-wiring.test.ts && pnpm --filter @loomic/server typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/application/generation apps/server/src/features/jobs apps/server/src/agent/runtime.ts
git commit -m "feat(server): persist attachment intent with generation"
```

### Task 6: Implement the Durable Attachment Reconciler

**Files:**
- Create: `apps/server/src/features/canvas/generated-asset-attachment-repository.ts`
- Create: `apps/server/src/features/canvas/generated-asset-attachment-repository.test.ts`
- Create: `apps/server/src/features/canvas/generated-asset-attachment-reconciler.ts`
- Create: `apps/server/src/features/canvas/generated-asset-attachment-reconciler.test.ts`
- Modify: `apps/server/src/features/canvas/generated-asset-application-adapter.ts`
- Modify: `apps/server/src/application/canvas/attach-generated-asset.ts`
- Modify: `apps/server/src/features/jobs/worker-job-lifecycle.ts`
- Modify: `apps/server/src/worker.ts`
- Test: `apps/server/src/application/canvas/attach-generated-asset.test.ts`
- Test: `apps/server/src/features/jobs/worker-job-lifecycle.test.ts`

- [ ] **Step 1: Write failing repository/reconciler tests**

Test startup scan, 5-second fallback scan, generation-settlement wakeup, 30-second lease, stale claimant rejection, retry schedule `[1,2,4,8,16,32,60,60]`, attempt exhaustion, canceled/dead-letter mapping, trusted element/file templates, and immediate replay:

```ts
const result = await reconciler.reconcileOnce();
expect(repository.fulfill).toHaveBeenCalledWith(expect.objectContaining({
  intentId: ids.intent,
  claimFence: 3,
  element: expect.objectContaining({ id: ids.job }),
  file: expect.objectContaining({ id: `${ids.job}-file`, assetId: ids.asset }),
}));
expect(result).toEqual({ claimed: 1, attached: 1, retried: 0, failed: 0 });
```

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm --filter @loomic/server exec vitest run src/features/canvas/generated-asset-attachment-repository.test.ts src/features/canvas/generated-asset-attachment-reconciler.test.ts src/features/jobs/worker-job-lifecycle.test.ts`

Expected: FAIL because reconciler modules do not exist.

- [ ] **Step 3: Implement repository, trusted templates, and worker loop**

The repository parses every RPC result with Zod and maps stable details to `AppError`. The adapter reads the claimed job and exact-scope `asset_objects` row, requires `asset_id`, builds schema-validated Excalidraw image/video templates using the job ID, and calls `fulfill`. It never downloads image bytes or persists signed URLs. The reconciler classifies deterministic integrity errors as `failed`, retryable infrastructure errors as `retry_wait`, and emits structured identifiers only.

Expose `start()`, `stop()`, `wake()`, and `reconcileOnce()`; call `wake()` after successful/canceled/dead-letter job settlement and run an immediate startup scan. Graceful worker shutdown waits for an active scan.

- [ ] **Step 4: Run focused and full server tests**

Run: `pnpm --filter @loomic/server test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/features/canvas apps/server/src/application/canvas apps/server/src/features/jobs/worker-job-lifecycle.ts apps/server/src/worker.ts
git commit -m "feat(worker): reconcile generated asset attachments"
```

### Task 7: Make Tool Outcomes Truthful and Preserve Recovery Metadata

**Files:**
- Create: `apps/server/src/agent/generated-media-result.ts`
- Modify: `apps/server/src/agent/tools/image-generate.ts`
- Modify: `apps/server/src/agent/tools/video-generate.ts`
- Modify: `apps/server/src/agent/tool-governance-middleware.ts`
- Modify: `apps/server/src/agent/tool-lifecycle.ts`
- Modify: `apps/server/src/agent/stream-adapter.ts`
- Modify: `apps/server/src/agent/runtime.ts`
- Test: `apps/server/src/agent/tools/tool-boundary.test.ts`
- Test: `apps/server/src/agent/tool-governance-middleware.test.ts`
- Test: `apps/server/src/agent/stream-adapter.test.ts`

- [ ] **Step 1: Add failing tool contract tests**

Assert attached output requires `elementId`/revision; generate-only returns `not_requested`; wait timeout returns error `ToolMessage` with `pending`; failed intent throws `GeneratedAssetAttachmentError`; arbitrary artifacts/data URLs are rejected; and canonical failure retains only validated recovery/artifacts.

```ts
expect(ToolMessage.isInstance(result)).toBe(true);
expect(result).toMatchObject({ status: "error", artifact: {
  type: "loomic.tool_error",
  recovery: { kind: "watch_generated_asset", jobId: ids.job, canvasId: ids.canvas },
}});
expect(published).toContainEqual(expect.objectContaining({ type: "loomic.tool.failed" }));
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm --filter @loomic/server exec vitest run src/agent/tools/tool-boundary.test.ts src/agent/tool-governance-middleware.test.ts src/agent/stream-adapter.test.ts`

Expected: FAIL because success output can omit attachment proof and failure projection drops recovery.

- [ ] **Step 3: Implement `content_and_artifact` and typed failures**

Use the installed LangChain contract:

```ts
tool(handler, {
  name: "generate_image",
  schema,
  responseFormat: "content_and_artifact",
});

return [modelVisibleSummary(result), generatedMediaToolResultSchema.parse(result)] as const;
```

Model-visible content says “attached” only for `attachmentStatus: "attached"`; pending tells the model background work continues and must not be regenerated. `GeneratedAssetAttachmentError` carries parsed private recovery/artifact data. Governance converts it to one error `ToolMessage` and one `loomic.tool.failed`; projection permits only safe fields and never raw tool output, prompt, object path, bytes, or signed URL identity.

- [ ] **Step 4: Run Agent tests and typecheck**

Run: `pnpm --filter @loomic/server exec vitest run src/agent && pnpm --filter @loomic/server typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/agent
git commit -m "fix(agent): report durable media attachment outcomes"
```

### Task 8: Add Authenticated Status and Recovery Endpoints

**Files:**
- Modify: `apps/server/src/application/canvas/attach-generated-asset.ts`
- Modify: `apps/server/src/http/jobs.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/web/src/lib/server-api.ts`
- Test: `apps/server/src/http/jobs.application-wiring.test.ts`
- Test: `apps/web/test/server-api.test.ts`

- [ ] **Step 1: Write failing authorization and response tests**

Cover:

```text
GET  /api/jobs/:jobId/attachment?canvasId=:canvasId
GET  /api/canvases/:canvasId/generated-asset-attachments?sessionId=:sessionId
POST /api/jobs/:jobId/attachment/retry   { canvasId }
```

Assert user/workspace/canvas/session scope, cross-session exclusion, bounded response schemas, idempotent retry, terminal attached replay, and no acceptance of placement/effect/object-path overrides.

- [ ] **Step 2: Run route/client tests and verify RED**

Run: `pnpm --filter @loomic/server exec vitest run src/http/jobs.application-wiring.test.ts && pnpm --filter @loomic/web exec vitest run test/server-api.test.ts`

Expected: FAIL with missing routes/client functions.

- [ ] **Step 3: Implement authenticated use cases and routes**

Authenticate first, authorize the canvas/job through repository joins, parse every response through shared schemas, and requeue only an existing failed intent (or create a deduplicated legacy recovery audit/intent). Add startup readiness that verifies required RPC availability and worker reconciler registration; canvas-mutating Agent generation remains fail-closed if unavailable.

- [ ] **Step 4: Run tests and typechecks**

Run: `pnpm --filter @loomic/server exec vitest run src/http/jobs.application-wiring.test.ts && pnpm --filter @loomic/web exec vitest run test/server-api.test.ts && pnpm typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/application/canvas apps/server/src/http/jobs.ts apps/server/src/app.ts apps/web/src/lib/server-api.ts apps/server/src/http/jobs.application-wiring.test.ts apps/web/test/server-api.test.ts
git commit -m "feat(api): expose generated asset recovery"
```

### Task 9: Add Phase-Aware Deadlines and Attempt Lease Recovery

**Files:**
- Create: `apps/server/src/agent/run-deadlines.ts`
- Create: `apps/server/src/agent/run-deadlines.test.ts`
- Modify: `apps/server/src/features/agent-runs/agent-execution-repository.ts`
- Modify: `apps/server/src/features/agent-runs/agent-execution-repository.test.ts`
- Modify: `apps/server/src/agent/runtime.ts`
- Modify: `apps/server/src/agent/runtime.application-wiring.test.ts`
- Modify: `apps/server/src/events/domain-event-publisher.ts`
- Modify: `apps/server/src/events/domain-event-publisher.test.ts`
- Modify: `apps/server/src/worker.ts`
- Modify: `packages/config/src/server.ts`
- Modify: `.env.example`

- [ ] **Step 1: Write failing deadline and lease tests**

Use fake timers to prove a silent model after a completed tool fails at model inactivity, an open tool survives that interval and fails only at its tool deadline, overall deadline always wins, all deadline paths abort and close the iterator once, leases renew every 15 seconds to 60 seconds, renewal failure fences subsequent effects, and expired recovery emits one terminal outbox event.

```ts
const guard = createRunDeadlineGuard({
  modelInactivityMs: 30_000,
  toolDeadlineMs: 10 * 60_000,
  overallDeadlineMs: 15 * 60_000,
  abortController,
  closeIterator,
});
guard.onToolStarted("tool-1");
await vi.advanceTimersByTimeAsync(30_001);
expect(guard.state()).toMatchObject({ phase: "tool", terminal: false });
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm --filter @loomic/server exec vitest run src/agent/run-deadlines.test.ts src/features/agent-runs/agent-execution-repository.test.ts src/agent/runtime.application-wiring.test.ts src/events/domain-event-publisher.test.ts`

Expected: FAIL because only first-event timeout and fixed 15-minute lease exist.

- [ ] **Step 3: Implement deadlines, renewal, and recovery**

`run-deadlines.ts` tracks model/tool phase and resets model inactivity on each model event. Tool start pauses model inactivity; tool completion/failure resumes it. Runtime aborts and calls iterator `return()` on terminal deadlines. Claim attempts for 60 seconds, renew every 15 seconds with the same owner/fence, and stop the renewal timer in `finally`; a failed renewal marks the fence invalid before any later effect/finalization.

The worker invokes `recover_expired_agent_runs(now, 30_000, limit)` on startup and every 5 seconds. The RPC locks eligible runs/attempts, marks them failed once, writes the terminal outbox event, and cannot race a valid resume. Publisher validates and delivers recovered `agent.run.failed` events. Add validated environment values with these defaults and structured phase/deadline/lease logs.

- [ ] **Step 4: Run server tests and typecheck**

Run: `pnpm --filter @loomic/server test && pnpm --filter @loomic/server typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/agent apps/server/src/features/agent-runs apps/server/src/events apps/server/src/worker.ts packages/config/src .env.example
git commit -m "fix(agent): bound runs with renewable leases"
```

### Task 10: Persist and Render Recovery Across Reloads

**Files:**
- Modify: `apps/web/src/hooks/use-chat-stream.ts`
- Modify: `apps/web/src/hooks/use-chat-sessions.ts`
- Modify: `apps/web/src/components/chat/tool-block-view.tsx`
- Modify: `apps/web/src/components/chat-sidebar.tsx`
- Modify: `apps/web/src/app/canvas/page.tsx`
- Test: `apps/web/test/chat-sidebar.test.tsx`
- Test: `apps/web/test/canvas-generation-ui.test.tsx`

- [ ] **Step 1: Write failing UI/session tests**

Assert failed attachment blocks retain error/recovery/artifact after save/reload, pending/attached/failed state is refreshed from authenticated status, outstanding session intents surface one notice after a process crash, retry reuses the same job, and Agent image/video events never invoke browser insertion callbacks.

```tsx
expect(screen.getByText("Generated, but not attached")).toBeVisible();
await user.click(screen.getByRole("button", { name: "Retry attachment" }));
expect(retryGeneratedAssetAttachment).toHaveBeenCalledWith(token, ids.canvas, ids.job);
expect(onImageGenerated).not.toHaveBeenCalled();
```

- [ ] **Step 2: Run focused Web tests and verify RED**

Run: `pnpm --filter @loomic/web exec vitest run test/chat-sidebar.test.tsx test/canvas-generation-ui.test.tsx`

Expected: FAIL because failed activities are not persisted/rendered and Agent artifacts still call browser insertion callbacks.

- [ ] **Step 3: Implement recovery state and UI**

Map `tool.failed` into a `status: "failed"` tool block including only parsed `error`, `recovery`, and `artifacts`; preserve those fields in session serialization. On load and run terminal events query status plus outstanding session intents. Render a compact generated-media preview with state text and a `RefreshCw` icon button labelled “Retry attachment” only for `attach_generated_asset`. Disable it while retry is pending and route successful attachment through canvas sync. Remove `onImageGenerated`/`onVideoGenerated` processing for Agent events from `chat-sidebar.tsx` and `page.tsx`; retain direct canvas toolbar generation behavior.

- [ ] **Step 4: Run full Web tests and typecheck**

Run: `pnpm --filter @loomic/web test && pnpm --filter @loomic/web typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/hooks apps/web/src/components/chat apps/web/src/components/chat-sidebar.tsx apps/web/src/app/canvas/page.tsx apps/web/test
git commit -m "feat(web): recover unattached generated media"
```

### Task 11: End-to-End Regression and Production Verification

**Files:**
- Create or Modify: `tests/canvas-generated-asset-reliability.spec.ts`
- Modify: `docs/superpowers/plans/2026-08-19-canvas-generated-asset-reliability.md`

- [ ] **Step 1: Add the browser regression**

Automate the original sequence with deterministic provider fixtures: open an idle populated canvas, wait beyond two legacy save intervals, verify revision is unchanged, start Agent image generation, inject a concurrent local edit, wait for attachment/sync/run terminal, verify one generated element plus the local edit, and immediately send a second message.

```ts
await expect.poll(() => readCanvasRevision(canvasId)).toBe(initialRevision);
await page.getByRole("textbox", { name: /message/i }).fill("Generate one image");
await page.getByRole("button", { name: /send/i }).click();
await expect(page.locator('[data-element-id="generated-job-id"]')).toHaveCount(1);
await expect(page.getByRole("button", { name: /send/i })).toBeEnabled();
```

- [ ] **Step 2: Run the regression against local services**

Run: `pnpm test:e2e -- tests/canvas-generated-asset-reliability.spec.ts`

Expected: PASS with one attachment and no stuck run.

- [ ] **Step 3: Run all quality gates with fresh output**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`

Run: `supabase db reset && supabase test db`

Expected: every command exits 0 with no failed tests.

- [ ] **Step 4: Inspect the production diff and acceptance checklist**

Run: `git diff --check && git status --short && git log --oneline --decorate -12`

Confirm every acceptance criterion in `docs/superpowers/specs/2026-08-19-canvas-generated-asset-reliability-design.md` has implementation and test evidence. Record any environment-only test gap explicitly; do not claim it passed.

- [ ] **Step 5: Commit final regression/docs updates**

```bash
git add tests/canvas-generated-asset-reliability.spec.ts docs/superpowers/plans/2026-08-19-canvas-generated-asset-reliability.md
git commit -m "test: verify generated asset reliability flow"
```

