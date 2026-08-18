# Phase 3 Tool-only Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove Agent arbitrary execution and user-extensible Skills, then run every Agent interaction through a persisted canvas-scoped capability context and an exact server-owned tool allowlist.

**Architecture:** Replace `createDeepAgent` and its automatic filesystem/Skill/subagent middleware with LangChain `createAgent`, a validated immutable built-in Skill catalog, and explicit Loomic tools. Release A removes dynamic Skill and shell paths before adding the catalog; Release B adds durable run attempts/effect fencing and drops the obsolete Skill schema only after architecture tests prove no readers remain.

**Tech Stack:** TypeScript, LangChain 1.2 `createAgent`, LangGraph checkpointer/store, Zod 4, Fastify, Supabase/Postgres, Vitest, Next.js.

---

## File Structure

- `apps/server/src/agent/builtin-skills/catalog.ts`: manifest/package validation, immutable bytes, digest, capability filtering.
- `apps/server/src/agent/builtin-skills/read-tool.ts`: bounded `read_builtin_skill` tool and per-run budget port.
- `apps/server/src/agent/capabilities.ts`: closed capability enum, policy resolution, exact tool/subagent declarations and digest.
- `apps/server/src/agent/execution-context.ts`: accepted context/attempt types and guards shared by every tool.
- `apps/server/src/agent/agent-factory.ts`: LangChain `createAgent` composition with only explicitly supplied tools.
- `apps/server/src/agent/tools/index.ts`: capability-filtered application tools; no backend or filesystem dependency.
- `apps/server/src/application/agent/accept-agent-run.ts`: canonical authorization, idempotent acceptance, persisted attempt/outbox.
- `apps/server/src/features/agent-runs/agent-execution-repository.ts`: Supabase persistence for contexts, attempts, leases, effects, and Skill budgets.
- `skills/builtin-skills.manifest.json`: closed built-in Skill allowlist containing only `json-image-prompt` initially.
- `supabase/migrations/20260819000000_phase3_agent_execution.sql`: run context, attempt, effect and Skill budget schema/RPCs.
- `supabase/migrations/20260819000001_phase3_remove_dynamic_skills.sql`: forward-only removal of `skill_files`, `workspace_skills`, `skills`, and related functions/triggers.

### Task 1: Remove arbitrary execution configuration and backends

**Files:**
- Delete: `apps/server/src/agent/backends/dev.ts`
- Delete: `apps/server/src/agent/backends/prod.ts`
- Delete: `apps/server/src/agent/backends/index.ts`
- Delete: `apps/server/src/agent/tools/persist-sandbox-file.ts`
- Modify: `packages/config/src/env.ts`
- Modify: `packages/config/src/env.test.ts`
- Modify: `apps/server/src/config/env.test.ts`
- Modify: `.env.example`
- Modify: `apps/server/package.json`
- Test: `apps/server/src/agent/agent-authority-architecture.test.ts`

- [ ] **Step 1: Write the failing architecture test**

Create a test that recursively parses `apps/server/src/agent/**/*.ts` and fails when production modules import `LocalShellBackend`, `SandboxBackendProtocol`, backend files, `node:child_process`, or define the tool names `execute` and `persist_sandbox_file`. Assert the config descriptors do not contain `LOOMIC_ALLOW_LOCAL_AGENT_EXECUTE`, `LOOMIC_AGENT_BACKEND_MODE`, `LOOMIC_AGENT_FILES_ROOT`, or `LOOMIC_SKILLS_ROOT`.

```ts
it("removes every Agent process and generic backend authority", async () => {
  const violations = await scanAgentAuthority();
  expect(violations).toEqual([]);
  expect(envDescriptors.map((item) => item.key)).not.toEqual(
    expect.arrayContaining([
      "LOOMIC_ALLOW_LOCAL_AGENT_EXECUTE",
      "LOOMIC_AGENT_BACKEND_MODE",
      "LOOMIC_AGENT_FILES_ROOT",
      "LOOMIC_SKILLS_ROOT",
    ]),
  );
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm --filter @loomic/server test -- src/agent/agent-authority-architecture.test.ts`

Expected: FAIL listing the current backend imports/config descriptors.

- [ ] **Step 3: Delete backend/persistence authority and configuration**

Remove the four config descriptors/properties and all `deepagents` backend imports. Delete the backend modules and `persist-sandbox-file.ts`. Remove `deepagents` from `apps/server/package.json` after Task 4 no longer imports it; until then leave the dependency but no sandbox backend construction.

- [ ] **Step 4: Run focused config and architecture tests**

Run: `pnpm --filter @loomic/config test && pnpm --filter @loomic/server test -- src/config/env.test.ts src/agent/agent-authority-architecture.test.ts`

Expected: PASS with no Agent process/filesystem authority.

- [ ] **Step 5: Commit**

```text
fix(agent): remove arbitrary execution backends
```

### Task 2: Remove dynamic Skill APIs, contracts, and web product surface

**Files:**
- Delete: `apps/server/src/application/skills/import-skill.ts`
- Delete: `apps/server/src/application/skills/import-skill.test.ts`
- Delete: `apps/server/src/features/skills/`
- Delete: `apps/server/src/http/skills.ts`
- Delete: `apps/server/src/http/skills-marketplace.ts`
- Delete: `apps/server/src/http/skills.import.test.ts`
- Delete: `apps/server/src/agent/workspace-skills.ts`
- Delete: `apps/web/src/app/(workspace)/skills/page.tsx`
- Delete: `apps/web/src/components/skills/`
- Delete: `apps/web/src/components/skeletons/skills-skeleton.tsx`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/application/use-cases.ts`
- Modify: `apps/server/src/http/route-errors.ts`
- Modify: `apps/web/src/components/app-sidebar.tsx`
- Modify: `apps/web/src/components/chat-sidebar.tsx`
- Modify: `apps/web/src/lib/server-api.ts`
- Modify: `packages/shared/src/contracts.ts`
- Modify: `packages/shared/src/index.ts`
- Delete: `packages/shared/src/skill-contracts.ts`
- Test: `tests/workspace.test.mjs`

- [ ] **Step 1: Add failing removal assertions**

Extend the workspace architecture test to assert there is no `/skills` page/sidebar item, no `/api/skills` route registration, no dynamic Skill API export, no `mentionType: "skill"`, and no server import from `application/skills` or `features/skills`.

- [ ] **Step 2: Run and verify RED**

Run: `node --test tests/workspace.test.mjs`

Expected: FAIL with current dynamic Skill files and route strings.

- [ ] **Step 3: Delete dynamic Skill modules and remove composition wiring**

Remove the `skills` property from `ApplicationUseCases`; remove import/marketplace route registration, rate limits, error adapters, chat Skill fetching/mentions, and all Skill client functions. Preserve `ChatSkills` only when it is a static prompt suggestion component; rename it if needed so it cannot be confused with runtime Skill management.

- [ ] **Step 4: Run shared/server/web tests and typechecks**

Run: `pnpm --filter @loomic/shared test && pnpm --filter @loomic/server test && pnpm --filter @loomic/web test && pnpm typecheck`

Expected: PASS and removed endpoints return normal 404 because they are unregistered.

- [ ] **Step 5: Commit**

```text
feat(skills): remove user-extensible Skill product paths
```

### Task 3: Build the immutable built-in Skill catalog

**Files:**
- Create: `skills/builtin-skills.manifest.json`
- Create: `apps/server/src/agent/builtin-skills/catalog.ts`
- Create: `apps/server/src/agent/builtin-skills/catalog.test.ts`
- Modify: `apps/server/src/app.ts`

- [ ] **Step 1: Write catalog RED tests**

Cover closed schema, unknown capability, duplicate name/path, identity mismatch, traversal, symlink/reparse point, file/count/byte limits, malformed frontmatter, deterministic digest, immutable copies, and exclusion of `canvas-design`.

```ts
expect(catalog.list()).toEqual([
  expect.objectContaining({
    name: "json-image-prompt",
    requiredCapabilities: ["image.generate"],
  }),
]);
expect(() => catalog.get("canvas-design")).toThrow("skill_not_found");
```

- [ ] **Step 2: Run and verify RED**

Run: `pnpm --filter @loomic/server test -- src/agent/builtin-skills/catalog.test.ts`

Expected: FAIL because the catalog API and manifest do not exist.

- [ ] **Step 3: Implement closed manifest/package validation**

Use Zod `.strict()`, `lstat`/`realpath`, `yaml.load`, sorted paths, copied `Uint8Array` content and `createHash("sha256")`. Resolve the packaged root from the application artifact, never an environment variable. Log only catalog digest and Skill names.

- [ ] **Step 4: Verify catalog tests and startup failure behavior**

Run: `pnpm --filter @loomic/server test -- src/agent/builtin-skills/catalog.test.ts`

Expected: PASS with `json-image-prompt` only.

- [ ] **Step 5: Commit**

```text
feat(skills): add immutable built-in Skill catalog
```

### Task 4: Replace DeepAgents auto-tools with an exact LangChain agent factory

**Files:**
- Create: `apps/server/src/agent/capabilities.ts`
- Create: `apps/server/src/agent/capabilities.test.ts`
- Create: `apps/server/src/agent/agent-factory.ts`
- Create: `apps/server/src/agent/agent-factory.test.ts`
- Delete: `apps/server/src/agent/deep-agent.ts`
- Modify: `apps/server/src/agent/sub-agents.ts`
- Modify: `apps/server/src/agent/runtime.ts`
- Modify: `apps/server/package.json`

- [ ] **Step 1: Write exact tool/subagent snapshot tests**

Define the closed enum and test every capability combination. Assert `execute`, `ls`, `glob`, `grep`, `read_file`, `write_file`, `edit_file`, and unclassified tools are absent from the main and video-agent snapshots.

```ts
expect(createAgentAuthority(policy).mainToolNames).toEqual([
  "generate_image",
  "inspect_canvas",
  "read_builtin_skill",
]);
expect(allToolNames).not.toEqual(expect.arrayContaining(FORBIDDEN_TOOL_NAMES));
```

- [ ] **Step 2: Run and verify RED**

Run: `pnpm --filter @loomic/server test -- src/agent/capabilities.test.ts src/agent/agent-factory.test.ts`

Expected: FAIL because current `createDeepAgent` injects framework tools/backends.

- [ ] **Step 3: Implement policy and `createAgent` composition**

Use `createAgent` from `langchain` with only the provided `StructuredTool[]`, the existing model/checkpointer, and Loomic system prompt. Implement delegation as an explicit `task` tool whose `subagentType` is a Zod enum of the server registry; construct the video agent with a strict subset of parent capabilities. Do not pass DeepAgents Skills, backend, filesystem middleware, or automatic subagents.

- [ ] **Step 4: Remove `deepagents` dependency and verify snapshots**

Run: `pnpm install --lockfile-only && pnpm --filter @loomic/server test -- src/agent/capabilities.test.ts src/agent/agent-factory.test.ts`

Expected: PASS and `pnpm why deepagents --filter @loomic/server` has no direct server dependency.

- [ ] **Step 5: Commit**

```text
refactor(agent): compose an exact tool-only LangChain agent
```

### Task 5: Add persisted canvas-scoped execution context and acceptance

**Files:**
- Modify: `packages/shared/src/contracts.ts`
- Modify: `packages/shared/src/contracts.test.ts`
- Create: `apps/server/src/agent/execution-context.ts`
- Create: `apps/server/src/application/agent/accept-agent-run.ts`
- Create: `apps/server/src/application/agent/accept-agent-run.test.ts`
- Create: `apps/server/src/features/agent-runs/agent-execution-repository.ts`
- Create: `apps/server/src/features/agent-runs/agent-execution-repository.test.ts`
- Modify: `apps/server/src/agent/runtime.ts`
- Modify: `apps/server/src/ws/handler.ts`
- Create: `supabase/migrations/20260819000000_phase3_agent_execution.sql`

- [ ] **Step 1: Write RED contract and acceptance tests**

Make `canvasId` and `clientRequestId` required. Test canonical project/workspace resolution, session/canvas mismatch rejection, duplicate identical acceptance returning one run, conflicting idempotency input rejection, persistence-before-acknowledgement, and no `conversationId` fallback.

- [ ] **Step 2: Run and verify RED**

Run: `pnpm --filter @loomic/shared test && pnpm --filter @loomic/server test -- src/application/agent/accept-agent-run.test.ts`

Expected: FAIL because `canvasId` is optional and runtime still falls back to conversation ID.

- [ ] **Step 3: Implement context, transaction and migration**

Persist `runId`, `attemptId`, `userId`, `workspaceId`, `projectId`, `canvasId`, sorted capabilities, policy version, catalog digest and effective Skill names through `AgentExecutionRepository`. Add unique `(user_id, client_request_id)`, attempt status/lease fields, and an outbox row in the same RPC transaction.

- [ ] **Step 4: Route HTTP/WS creation through `AcceptAgentRun`**

Delete fallback resolution and reject missing context with `canvas_context_required`. Log correlation IDs and effective authority without prompt/content.

- [ ] **Step 5: Run focused tests and migration reset**

Run: `pnpm --filter @loomic/shared test && pnpm --filter @loomic/server test -- src/application/agent/accept-agent-run.test.ts src/ws/handler.authorization.test.ts && supabase db reset --local`

Expected: PASS.

- [ ] **Step 6: Commit**

```text
feat(agent): persist canonical canvas execution context
```

### Task 6: Add bounded built-in Skill reading

**Files:**
- Create: `apps/server/src/agent/builtin-skills/read-tool.ts`
- Create: `apps/server/src/agent/builtin-skills/read-tool.test.ts`
- Modify: `apps/server/src/features/agent-runs/agent-execution-repository.ts`
- Modify: `supabase/migrations/20260819000000_phase3_agent_execution.sql`
- Modify: `apps/server/src/agent/tools/index.ts`

- [ ] **Step 1: Write RED tests for Skill authority and budgets**

Test `skill.read`, effective-name membership, required-capability intersection, normalized path containment, text-only output, opaque cursor binding, 32 KiB page, 16 distinct reads, 256 KiB atomic per-run budget, main/subagent sharing, idempotent retry and cross-run cursor rejection.

- [ ] **Step 2: Run and verify RED**

Run: `pnpm --filter @loomic/server test -- src/agent/builtin-skills/read-tool.test.ts`

Expected: FAIL because `read_builtin_skill` does not exist.

- [ ] **Step 3: Implement tool and atomic budget RPC**

Generate 256-bit random opaque cursors and persist their run/Skill/path/position binding through `AgentExecutionRepository`; never expose filesystem paths or add a new cursor secret. Reserve logical-read count and bytes with one conditional SQL statement keyed by `runId + skillName + normalizedPath + cursorOrStart`.

- [ ] **Step 4: Verify concurrency and cursor tests**

Run: `pnpm --filter @loomic/server test -- src/agent/builtin-skills/read-tool.test.ts`

Expected: PASS including concurrent overspend rejection.

- [ ] **Step 5: Commit**

```text
feat(skills): expose bounded built-in Skill reading
```

### Task 7: Enforce capability-aware application tools

**Files:**
- Modify: `apps/server/src/agent/tools/index.ts`
- Modify: `apps/server/src/agent/tools/inspect-canvas.ts`
- Modify: `apps/server/src/agent/tools/manipulate-canvas.ts`
- Modify: `apps/server/src/agent/tools/image-generate.ts`
- Modify: `apps/server/src/agent/tools/video-generate.ts`
- Modify: `apps/server/src/agent/tools/brand-kit.ts`
- Modify: `apps/server/src/agent/tools/project-search.ts`
- Modify: `apps/server/src/agent/tools/screenshot-canvas.ts`
- Create: `apps/server/src/agent/tools/tool-guard.ts`
- Create: `apps/server/src/agent/tools/tool-boundary.test.ts`

- [ ] **Step 1: Write RED boundary tests**

Assert tools receive a bound `AgentExecutionContext`, never accept canvas/project/workspace IDs, validate asset/job/node ownership, reject raw URLs/storage paths, enforce 256 KiB input/100 operations/64 KiB output/100 records/screenshot limits, recheck active attempt/current authorization, and pass `runId + logicalToolCallId` to effectful use cases.

- [ ] **Step 2: Run and verify RED**

Run: `pnpm --filter @loomic/server test -- src/agent/tools/tool-boundary.test.ts`

Expected: FAIL because current tools read configurable IDs/tokens and some access Supabase directly.

- [ ] **Step 3: Implement shared guard and application-port adapters**

Remove Supabase/browser/repository construction from tools. Inject canonical application ports; perform pre-read and transactional pre-effect guards; return stable errors and bounded results. Generation-specific persistence accepts only the provider result associated with the bound job; canvas insertion separately requires `canvas.mutate`.

- [ ] **Step 4: Run all Agent tool tests**

Run: `pnpm --filter @loomic/server test -- src/agent/tools`

Expected: PASS with exact tool snapshots unchanged by optional dependencies.

- [ ] **Step 5: Commit**

```text
feat(agent): enforce canvas-scoped tool capabilities
```

### Task 8: Add attempt leases, effect idempotency, and cancellation fencing

**Files:**
- Modify: `apps/server/src/features/agent-runs/agent-execution-repository.ts`
- Modify: `apps/server/src/features/agent-runs/agent-execution-repository.test.ts`
- Modify: `apps/server/src/agent/runtime.ts`
- Modify: `apps/server/src/agent/stream-adapter.ts`
- Modify: `supabase/migrations/20260819000000_phase3_agent_execution.sql`
- Modify: `supabase/tests/phase_3_agent_execution.test.sql`

- [ ] **Step 1: Write RED lease/effect race tests**

Cover single lease owner, fencing-token rollover, stale event/tool rejection, checkpoint-before-effect order, effect replay with identical input, conflict with changed input, cancellation versus effect commit, lease loss versus effect commit, and resume catalog/policy changes.

- [ ] **Step 2: Run and verify RED**

Run: `pnpm --filter @loomic/server test -- src/features/agent-runs/agent-execution-repository.test.ts`

Expected: FAIL because runtime records are currently process-local and unfenced.

- [ ] **Step 3: Implement conditional RPCs and runtime ordering**

Add `claim_agent_attempt`, `record_agent_effect`, `cancel_agent_attempt`, and resume RPCs. Require active status and matching fencing token in the same transaction as business effect/outbox writes. Persist tool request checkpoint before effect invocation and result before advancing checkpoint.

- [ ] **Step 4: Run unit and database race tests**

Run: `pnpm --filter @loomic/server test -- src/features/agent-runs/agent-execution-repository.test.ts && supabase test db --local`

Expected: PASS with losing calls creating no published job/asset/canvas mutation.

- [ ] **Step 5: Commit**

```text
feat(agent): fence attempts and deduplicate tool effects
```

### Task 9: Drop dynamic Skill database schema

**Files:**
- Create: `supabase/migrations/20260819000001_phase3_remove_dynamic_skills.sql`
- Create: `supabase/tests/phase_3_skill_removal.test.sql`

- [ ] **Step 1: Write the failing SQL verification**

Assert `public.skill_files`, `public.workspace_skills`, `public.skills`, `public.init_workspace_skills`, `public.update_skills_updated_at`, their policies/triggers/indexes and grants are absent after all migrations.

- [ ] **Step 2: Run and verify RED**

Run: `supabase db reset --local && supabase test db --local`

Expected: FAIL because dynamic Skill relations/functions still exist.

- [ ] **Step 3: Add forward-only dependency-ordered drop migration**

Drop triggers/functions first, then `skill_files`, `workspace_skills`, and `skills`. Do not archive, migrate, or create compatibility views.

- [ ] **Step 4: Reset and verify the database**

Run: `supabase db reset --local && supabase test db --local`

Expected: PASS from zero with no dynamic Skill schema.

- [ ] **Step 5: Commit**

```text
feat(skills): remove dynamic Skill database schema
```

### Task 10: Complete architecture, regression, and release verification

**Files:**
- Modify: `tests/workspace.test.mjs`
- Modify: `docs/tech/engineering-issues-register.md`
- Create: `docs/tech/phase-3-verification.md`
- Modify: `README.md`
- Modify: `CODEMAP.md` if present
- Modify: `docs/tech/canvas-design-integration.md`

- [ ] **Step 1: Add final architecture assertions**

Assert no forbidden config/routes/tables/imports, exact main/subagent tool snapshots, required canvas contract, built-in manifest eligibility, excluded `canvas-design`, tool schema restrictions, no process-spawn API, and no direct Agent repository/Supabase/browser access outside tool adapters.

- [ ] **Step 2: Run focused and full verification**

Run:

```text
pnpm lint
pnpm typecheck
pnpm test
pnpm build
supabase db reset --local
supabase test db --local
git diff --check
```

Expected: all commands exit 0. If Biome still scans unrelated `.worktrees` output, fix the repository ignore configuration rather than deleting another worktree.

- [ ] **Step 3: Run browser smoke tests**

Verify an authorized canvas can inspect, mutate and generate; missing/cross-canvas context is rejected; `/skills` and `/api/skills*` are absent; one user with two canvases cannot misroute screenshot or generated results.

- [ ] **Step 4: Record exact evidence and close ENG-027/ENG-030**

Write command outputs/counts and residual risks in `phase-3-verification.md`. Do not mark complete if any forbidden tool appears or any database/UI dynamic Skill path remains.

- [ ] **Step 5: Commit**

```text
docs: verify phase 3 tool-only Agent governance
```
