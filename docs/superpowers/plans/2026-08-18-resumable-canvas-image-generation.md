# Resumable Canvas Image Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace browser-bound canvas image generation with durable background jobs that reconcile safely after navigation or reload without duplicate charges.

**Architecture:** The server job and atomic idempotency record own execution and charging; the persisted Excalidraw generator owns placement and its attempt link. A canvas-level reconciler submits/replays immutable attempts, validates job context, polls retryable states, and applies successful assets through the editor's revision-aware durable mutation coordinator.

**Tech Stack:** TypeScript, Zod, Fastify, Supabase/PostgreSQL, React 19, Next.js 15, Excalidraw 0.18, Vitest, Testing Library, pnpm/Turbo.

---

## File Map

- Modify `packages/shared/src/job-contracts.ts`: add reference asset IDs to image job payloads and expose replay-safe job contracts.
- Modify `packages/shared/src/contracts.test.ts`: prove strict request parsing for reference assets.
- Modify `apps/server/src/features/jobs/generation-application-adapter.ts`: accept non-queued statuses on idempotent replay.
- Modify `apps/server/src/features/jobs/generation-application-adapter.test.ts`: cover replay in every legal state.
- Create `apps/server/src/application/generation/reference-assets.ts`: authorize project reference assets before charging.
- Create `apps/server/src/application/generation/reference-assets.test.ts`: cover missing, foreign, and valid assets.
- Modify `apps/server/src/application/generation/ports.ts`: add the focused reference-asset authorization port.
- Modify `apps/server/src/application/generation/submit-generation.ts`: authorize reference assets before atomic submission.
- Modify `apps/server/src/application/generation/submit-generation.test.ts`: prove ordering and fingerprint input.
- Modify `apps/server/src/app.ts`: wire the reference-asset port.
- Modify `apps/server/src/features/jobs/executors/image-generation.ts`: resolve reference asset URLs at execution and persist output `project_id`.
- Create `apps/server/src/features/jobs/executors/image-generation.test.ts`: prove input/output asset ownership.
- Modify `apps/web/src/lib/canvas-image-generator.ts`: persist attempt metadata and enforce immutable request fields while generating.
- Modify `apps/web/test/canvas-elements.test.ts`: cover generator compare-and-set helpers and asset-backed image metadata.
- Create `apps/web/src/lib/canvas-generation-reconciler.ts`: pure attempt/job classification, context validation, and result planning.
- Create `apps/web/test/canvas-generation-reconciler.test.ts`: exhaustive state-machine and stale-attempt tests.
- Modify `apps/web/src/lib/server-api.ts`: add typed image-job submission and reuse job/asset APIs.
- Create `apps/web/src/hooks/use-canvas-image-generation.ts`: canvas-level operation registry, submission replay, polling, and completion.
- Create `apps/web/test/canvas-image-generation.test.tsx`: timers, reload recovery, deletion, auth, and transient-error tests.
- Modify `apps/web/src/components/canvas-editor.tsx`: expose serialized durable scene mutations and persist generated `assetId` metadata.
- Create `apps/web/test/canvas-editor-persistence.test.tsx`: immediate-save ordering, ambiguous outcomes, revision conflict, and asset round trips.
- Modify `apps/web/src/components/canvas/image-generator-panel.tsx`: upload references, acquire synchronous submission guard, and stop using the synchronous endpoint.
- Modify `apps/web/src/components/canvas-tool-menu.tsx`: pass project/canvas context and submission commands.
- Modify `apps/web/src/components/canvas-editor.tsx`: mount the reconciler with editor lifetime.
- Modify `apps/web/src/app/canvas/page.tsx`: provide authenticated user ID and existing project/canvas IDs.
- Modify `apps/web/test/canvas-generation-ui.test.tsx`: replace synchronous expectations with durable job behavior.
- Modify `apps/web/src/hooks/use-generation-error-handler.ts`: keep one expected-error logging owner.

### Task 1: Shared Image Job Contract And Replay Semantics

**Files:**
- Modify: `packages/shared/src/job-contracts.ts`
- Modify: `packages/shared/src/contracts.test.ts`
- Modify: `apps/server/src/features/jobs/generation-application-adapter.ts`
- Modify: `apps/server/src/features/jobs/generation-application-adapter.test.ts`

- [ ] **Step 1: Write failing shared contract tests**

Add cases that accept UUID reference assets and reject unknown/invalid values:

```ts
expect(createImageJobRequestSchema.parse({
  idempotency_key: "attempt-1",
  project_id: ids.project,
  canvas_id: ids.canvas,
  prompt: "draw",
  input_asset_ids: [ids.asset],
})).toMatchObject({ input_asset_ids: [ids.asset] });
expect(() => createImageJobRequestSchema.parse({
  idempotency_key: "attempt-1",
  prompt: "draw",
  input_asset_ids: ["not-a-uuid"],
})).toThrow();
```

- [ ] **Step 2: Run the shared test and verify RED**

Run: `pnpm --filter @loomic/shared test -- contracts.test.ts`

Expected: FAIL because `input_asset_ids` is rejected by the strict schema.

- [ ] **Step 3: Implement the shared contract**

Add one reusable field and include it in both the image payload and direct image-job request:

```ts
const inputAssetIdsShape = {
  input_asset_ids: z.array(z.string().uuid()).max(8).optional(),
};

export const imageGenerationPayloadSchema = z.object({
  prompt: z.string().min(1),
  ...inputAssetIdsShape,
  // existing fields remain unchanged
});
```

- [ ] **Step 4: Write failing adapter replay tests**

Use `it.each` over `queued`, `running`, `failed`, `cancel_requested`, `succeeded`, `dead_letter`, and `canceled`. For `replayed: true`, expect the adapter to return the original ID; retain rejection of a non-replayed non-queued outcome.

```ts
await expect(ports.jobs.submit(command)).resolves.toEqual({
  id: jobId,
  status,
  replayed: true,
});
```

- [ ] **Step 5: Run the adapter test and verify RED**

Run: `pnpm --filter @loomic/server test -- src/features/jobs/generation-application-adapter.test.ts`

Expected: FAIL with `invalidLegacyOutcome` for replayed non-queued jobs.

- [ ] **Step 6: Widen only replay outcomes**

Change `GenerationSubmissionOutcome.status` to `BackgroundJobStatus`. Map the repository outcome as follows:

```ts
if (!outcome.replayed && outcome.job.status !== "queued") {
  throw invalidLegacyOutcome();
}
return {
  id: outcome.job.id,
  status: outcome.job.status,
  replayed: outcome.replayed,
};
```

Keep `SubmitGeneration` returning the accepted `jobId`; `/api/jobs/image-generation` already fetches and returns the current `JobResponse`.

- [ ] **Step 7: Run focused tests and commit**

Run: `pnpm --filter @loomic/shared test -- contracts.test.ts && pnpm --filter @loomic/server test -- src/features/jobs/generation-application-adapter.test.ts src/http/jobs.application-wiring.test.ts`

Expected: PASS.

```text
git add packages/shared/src/job-contracts.ts packages/shared/src/contracts.test.ts apps/server/src/features/jobs/generation-application-adapter.ts apps/server/src/features/jobs/generation-application-adapter.test.ts
git commit -m "feat(generation): support replayable image job inputs"
```

### Task 2: Reference Asset Authorization And Worker Resolution

**Files:**
- Create: `apps/server/src/application/generation/reference-assets.ts`
- Create: `apps/server/src/application/generation/reference-assets.test.ts`
- Modify: `apps/server/src/application/generation/ports.ts`
- Modify: `apps/server/src/application/generation/submit-generation.ts`
- Modify: `apps/server/src/application/generation/submit-generation.test.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/features/jobs/executors/image-generation.ts`
- Create: `apps/server/src/features/jobs/executors/image-generation.test.ts`

- [ ] **Step 1: Write failing authorization-order tests**

Define a port whose contract returns normalized IDs or throws before `jobs.submit`:

```ts
referenceAssets.authorize({
  workspaceId: principal.workspaceId,
  projectId: request.project_id!,
  assetIds: request.input_asset_ids ?? [],
});
expect(referenceAssets.authorize).toHaveBeenCalledBefore(ports.jobs.submit);
expect(ports.jobs.submit).not.toHaveBeenCalled();
```

Cover duplicate IDs, a missing project ID when references exist, foreign project/workspace assets, and valid ordered IDs.

- [ ] **Step 2: Run application tests and verify RED**

Run: `pnpm --filter @loomic/server test -- src/application/generation/reference-assets.test.ts src/application/generation/submit-generation.test.ts`

Expected: FAIL because the port and use case do not exist.

- [ ] **Step 3: Implement the focused authorization port**

Use the authenticated Supabase client to select `id, workspace_id, project_id, bucket, object_path, mime_type` for all IDs. Require an exact count, matching workspace/project, and `image/*` MIME. Return IDs in request order; throw exposed `invalid_request`/`forbidden` errors without logging URLs.

Call it after model/tier validation but before `jobs.submit`, so invalid references cannot deduct credits. Keep `input_asset_ids` inside `mediaPayload`, which automatically includes them in the canonical request fingerprint.

- [ ] **Step 4: Write failing executor tests**

Build an admin client fixture with one reference asset and assert the provider receives a freshly resolved URL, while the generated asset insert includes project ownership:

```ts
expect(generateImage).toHaveBeenCalledWith(expect.anything(), expect.anything(),
  expect.objectContaining({ inputImages: [signedReferenceUrl] }));
expect(assetInsert).toHaveBeenCalledWith(expect.objectContaining({
  project_id: projectId,
  generation_job_id: jobId,
}));
```

- [ ] **Step 5: Run executor test and verify RED**

Run: `pnpm --filter @loomic/server test -- src/features/jobs/executors/image-generation.test.ts`

Expected: FAIL because the executor neither loads reference assets nor selects/inserts `project_id`.

- [ ] **Step 6: Resolve assets immediately before provider execution**

Select `project_id` with the job. Resolve every persisted asset ID through storage immediately before `generateImage`, preserving request order. Revalidate workspace/project/MIME. Insert the output record with both `project_id` and `generation_job_id`. Return `asset_id`, dimensions, and MIME; the client must not depend on `getPublicUrl` as durable state.

- [ ] **Step 7: Run focused tests and commit**

Run: `pnpm --filter @loomic/server test -- src/application/generation/submit-generation.test.ts src/application/generation/reference-assets.test.ts src/features/jobs/executors/image-generation.test.ts src/http/jobs.application-wiring.test.ts`

Expected: PASS.

```text
git add apps/server/src/application/generation apps/server/src/features/jobs/executors/image-generation.ts apps/server/src/features/jobs/executors/image-generation.test.ts apps/server/src/app.ts
git commit -m "feat(server): authorize image job assets"
```

### Task 3: Generator Attempt Model And Pure Reconciliation Rules

**Files:**
- Modify: `apps/web/src/lib/canvas-image-generator.ts`
- Create: `apps/web/src/lib/canvas-generation-reconciler.ts`
- Create: `apps/web/test/canvas-generation-reconciler.test.ts`
- Modify: `apps/web/test/canvas-elements.test.ts`

- [ ] **Step 1: Write failing attempt-state tests**

Cover immutable request fields while generating, compare-and-set updates, job context validation, status classification, and result validation:

```ts
expect(updateAttempt(element, oldKey, { jobId })).toMatchObject({
  customData: { idempotencyKey: oldKey, jobId },
});
expect(updateAttempt(newerElement, oldKey, { jobId })).toBe(newerElement);
expect(classifyJob({ status: "failed" })).toBe("poll");
expect(classifyJob({ status: "dead_letter" })).toBe("terminal-error");
expect(validateJobContext(job, context)).toEqual({ ok: false, code: "job_context_mismatch" });
```

- [ ] **Step 2: Run pure web tests and verify RED**

Run: `pnpm --filter @loomic/web test -- canvas-generation-reconciler.test.ts canvas-elements.test.ts`

Expected: FAIL because the functions and attempt fields do not exist.

- [ ] **Step 3: Implement minimal pure functions**

Extend `ImageGeneratorData` with `referenceAssetIds`, `jobId`, and `idempotencyKey`. Add helpers that never mutate request fields during `generating`, apply updates only when the captured key matches, build the snake-case submission body, validate `created_by/project_id/canvas_id/job_type`, classify `failed` as pollable, and parse successful results into:

```ts
type ImageJobResult = {
  assetId: string;
  mimeType: `image/${string}`;
  width: number;
  height: number;
};
```

- [ ] **Step 4: Run tests and commit**

Run: `pnpm --filter @loomic/web test -- canvas-generation-reconciler.test.ts canvas-elements.test.ts`

Expected: PASS.

```text
git add apps/web/src/lib/canvas-image-generator.ts apps/web/src/lib/canvas-generation-reconciler.ts apps/web/test/canvas-generation-reconciler.test.ts apps/web/test/canvas-elements.test.ts
git commit -m "feat(web): model durable image attempts"
```

### Task 4: Revision-Aware Durable Canvas Mutations

**Files:**
- Modify: `apps/web/src/components/canvas-editor.tsx`
- Create: `apps/web/test/canvas-editor-persistence.test.tsx`
- Modify: `apps/web/src/lib/canvas-elements.ts`

- [ ] **Step 1: Write failing persistence coordinator tests**

Use a fake Excalidraw API and deferred `saveCanvas` calls. Prove an immediate mutation cancels pending debounce, saves through the revision chain, waits for acknowledgement, preserves later edits, and classifies timeout as ambiguous rather than rejected. Add an asset round-trip assertion:

```ts
expect(saved.content.files[fileId]).toEqual({
  id: fileId,
  mimeType: "image/png",
  created: 1,
  assetId,
});
expect(saved.content.files[fileId]).not.toHaveProperty("dataURL");
```

- [ ] **Step 2: Run persistence tests and verify RED**

Run: `pnpm --filter @loomic/web test -- canvas-editor-persistence.test.tsx`

Expected: FAIL because no durable mutation API or asset-backed serializer exists.

- [ ] **Step 3: Extract the save coordinator inside CanvasEditor**

Expose a stable callback through `onApiReady`'s editor bridge or a new `onPersistenceReady` prop:

```ts
type DurableSceneMutation = (
  mutate: (elements: readonly any[]) => any[],
) => Promise<{ kind: "committed"; revision: number } | { kind: "rejected" } | { kind: "ambiguous" }>;
```

Cancel the debounce, serialize behind `saveChainRef`, suppress the coordinator's own `onChange`, and update `revisionRef` only from acknowledged responses. On ambiguous outcomes, call `fetchCanvas` and compare the attempt key before returning a decision.

- [ ] **Step 4: Persist and hydrate asset-backed files**

For runtime files with `assetId`, serialize only `id/mimeType/created/assetId`. During hydration, call `getAssetUrl`, download the current data URL, add it to Excalidraw, and retain `assetId` on the runtime file object. Keep the existing format unchanged for files without `assetId`.

- [ ] **Step 5: Run tests and commit**

Run: `pnpm --filter @loomic/web test -- canvas-editor-persistence.test.tsx canvas-elements.test.ts`

Expected: PASS.

```text
git add apps/web/src/components/canvas-editor.tsx apps/web/src/lib/canvas-elements.ts apps/web/test/canvas-editor-persistence.test.tsx apps/web/test/canvas-elements.test.ts
git commit -m "feat(canvas): add durable scene mutations"
```

### Task 5: Canvas-Level Image Job Reconciler

**Files:**
- Create: `apps/web/src/hooks/use-canvas-image-generation.ts`
- Create: `apps/web/test/canvas-image-generation.test.tsx`
- Modify: `apps/web/src/lib/server-api.ts`

- [ ] **Step 1: Write failing hook tests with fake timers**

Cover scan-on-mount, no-job-ID replay, immediate polling after submit, job-ID save failure, retryable `failed`, capped backoff, auth pause/resume, 404 same-key replay, stale attempt, invalid context, successful replacement with live geometry, deletion, and unmount cleanup.

```ts
expect(submitImageJob).toHaveBeenCalledWith(token, expect.objectContaining({
  idempotency_key: attemptKey,
  canvas_id: canvasId,
  project_id: projectId,
}));
expect(submitImageJob).toHaveBeenCalledTimes(1);
expect(new Set(submitImageJob.mock.calls.map((call) => call[1].idempotency_key)))
  .toEqual(new Set([attemptKey]));
```

- [ ] **Step 2: Run hook tests and verify RED**

Run: `pnpm --filter @loomic/web test -- canvas-image-generation.test.tsx`

Expected: FAIL because the hook and submit API do not exist.

- [ ] **Step 3: Add typed server API helpers**

Implement `submitImageJob(accessToken, body): Promise<JobResponse>` with `createImageJobRequestSchema` and `jobResponseSchema`. Continue using `fetchJob` and `getAssetUrl`; do not add a second polling client.

- [ ] **Step 4: Implement one operation registry**

Key submission operations by `elementId:idempotencyKey` and polls by `jobId`. Acquire guards synchronously. Scan all live generating elements whenever scene/auth becomes ready. Use recursive `setTimeout` with capped exponential backoff so async calls never overlap.

- [ ] **Step 5: Implement completion and deletion races**

Before and after asset download, reload the live element and compare `idempotencyKey/jobId/isDeleted`. Register a runtime file containing `assetId`, create the image from the latest geometry/group/frame metadata, and durable-mutate the replacement. If save is ambiguous or rejected, restore the same generating attempt and retry persistence; never create a new key.

Detect generating-node deletion transitions from scene updates and route them through the immediate durable mutation before releasing tracking.

- [ ] **Step 6: Run hook tests and commit**

Run: `pnpm --filter @loomic/web test -- canvas-image-generation.test.tsx canvas-generation-reconciler.test.ts`

Expected: PASS with fake timers fully drained and no leaked timer warnings.

```text
git add apps/web/src/hooks/use-canvas-image-generation.ts apps/web/src/lib/server-api.ts apps/web/test/canvas-image-generation.test.tsx
git commit -m "feat(canvas): reconcile background image jobs"
```

### Task 6: Panel Submission And Reference Uploads

**Files:**
- Modify: `apps/web/src/components/canvas/image-generator-panel.tsx`
- Modify: `apps/web/src/components/canvas-tool-menu.tsx`
- Modify: `apps/web/test/canvas-generation-ui.test.tsx`
- Modify: `apps/web/src/hooks/use-generation-error-handler.ts`

- [ ] **Step 1: Replace synchronous UI tests with failing job tests**

Assert Enter/double-click calls one canvas-level `startAttempt`, never calls `generateImageDirect`, disables request fields during generating, uploads references once through `uploadFile`, and persists only returned asset IDs.

```ts
fireEvent.keyDown(prompt, { key: "Enter" });
fireEvent.keyDown(prompt, { key: "Enter" });
expect(startAttempt).toHaveBeenCalledOnce();
expect(generateImageDirectMock).not.toHaveBeenCalled();
```

- [ ] **Step 2: Run UI tests and verify RED**

Run: `pnpm --filter @loomic/web test -- canvas-generation-ui.test.tsx`

Expected: FAIL because the panel still calls the synchronous endpoint and keeps references in local data URLs.

- [ ] **Step 3: Convert the panel to commands**

Accept `startAttempt(elementId, requestFields)` from the canvas-level hook. Upload selected reference files immediately with `uploadFile(token, file, projectId)`, store `{ assetId, previewUrl }` in panel state, and persist only `referenceAssetIds`. Disable prompt/model/ratio/quality/reference controls for generating nodes. Remove the module-level `activeImageGenerations`, completion download/replacement, and orphan-to-error effect.

- [ ] **Step 4: Remove duplicate expected-error logging**

The hook/panel calls `handleGenerationError` once for terminal application errors. Remove the panel's raw `console.error`; keep structured reconciler warnings for transient status fetches.

- [ ] **Step 5: Run UI tests and commit**

Run: `pnpm --filter @loomic/web test -- canvas-generation-ui.test.tsx`

Expected: PASS and no console error output.

```text
git add apps/web/src/components/canvas/image-generator-panel.tsx apps/web/src/components/canvas-tool-menu.tsx apps/web/src/hooks/use-generation-error-handler.ts apps/web/test/canvas-generation-ui.test.tsx
git commit -m "feat(canvas): submit image generators as jobs"
```

### Task 7: Editor Integration And Full Verification

**Files:**
- Modify: `apps/web/src/components/canvas-editor.tsx`
- Modify: `apps/web/src/app/canvas/page.tsx`
- Modify: `apps/web/test/canvas-image-generation.test.tsx`
- Modify: `apps/web/test/canvas-generation-ui.test.tsx`

- [ ] **Step 1: Write failing integration cases**

Mount the editor with two unselected generating nodes. Assert both are reconciled, auth restoration rescans, changing canvas cleans old polls, a completed job replaces only its matching node, and editor unmount never calls cancellation.

- [ ] **Step 2: Run integration tests and verify RED**

Run: `pnpm --filter @loomic/web test -- canvas-image-generation.test.tsx canvas-generation-ui.test.tsx`

Expected: FAIL until the hook is mounted at editor lifetime with user/project/canvas context.

- [ ] **Step 3: Mount the reconciler and connect commands**

Pass `userId`, `projectId`, `canvasId`, token, Excalidraw API, and durable mutation coordinator into `useCanvasImageGeneration`. Forward its `startAttempt` to `CanvasToolMenu`/`ImageGeneratorPanel`. Ensure panel selection has no effect on active jobs.

- [ ] **Step 4: Run focused web and server suites**

Run:

```text
pnpm --filter @loomic/shared test
pnpm --filter @loomic/server test -- src/application/generation src/features/jobs/executors/image-generation.test.ts src/http/jobs.application-wiring.test.ts
pnpm --filter @loomic/web test -- canvas-generation-reconciler.test.ts canvas-editor-persistence.test.tsx canvas-image-generation.test.tsx canvas-generation-ui.test.tsx canvas-elements.test.ts
```

Expected: PASS without unhandled promises, leaked timers, duplicate console errors, or snapshot churn.

- [ ] **Step 5: Run static and production verification**

Run:

```text
pnpm --filter @loomic/shared typecheck
pnpm --filter @loomic/server typecheck
pnpm --filter @loomic/web typecheck
pnpm lint
pnpm --filter @loomic/server build
$env:NEXT_DIST_DIR='.next-resumable-image-generation'; pnpm --filter @loomic/web build
```

Expected: all commands exit 0. Remove only the isolated `.next-resumable-image-generation` build output after verifying its resolved path is inside `apps/web`.

- [ ] **Step 6: Commit the integration**

```text
git add apps/web/src/app/canvas/page.tsx apps/web/src/components/canvas-editor.tsx apps/web/test/canvas-image-generation.test.tsx apps/web/test/canvas-generation-ui.test.tsx
git commit -m "feat(canvas): resume image generation across reloads"
```

- [ ] **Step 7: Record final evidence**

Run `git status --short` and `git log -7 --oneline`. Expected: clean worktree and one focused commit per completed task. Record exact test/build results in the final handoff; do not claim checks that were not run.
