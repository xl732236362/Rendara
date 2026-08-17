# Phase 1 Contracts And Application Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish one validated contract/configuration/error boundary and one reusable application orchestration path for Loomic's HTTP, WebSocket, Agent, and Worker entry points.

**Architecture:** Strengthen `@loomic/shared` as the current contract authority, add pure application use cases behind explicit ports, and construct registries/use cases in `app.ts` and `worker.ts`. Preserve phase 0 security boundaries and defer transactional job semantics, canvas revision, full model catalog, and directory-wide clean architecture migration to their assigned later phases.

**Tech Stack:** TypeScript 5, Zod 4, Fastify 5, Next.js 15, LangGraph/DeepAgents, Vitest, Biome, Turborepo

---

## Scope And Preconditions

- Phase 0 is merged on `main`; `pnpm ci:check` passes with 157 tests and 465 recorded lint warnings.
- In scope: ENG-019, ENG-020, ENG-021, ENG-022, ENG-024, ENG-026, plus the application-boundary portion of ENG-017 and the contract foundation for ENG-012/023.
- Deferred: database transactions/state machine/revision (phase 2), sandbox and Skill trust (phase 3), full canvas node registry (phase 4), shared realtime state (phase 5), Query caching/component decomposition (phase 6), global telemetry (phase 7).
- Phase 1 does not claim ENG-007, ENG-008, ENG-009, ENG-012-014, ENG-017, ENG-023, or ENG-025 fully solved where the roadmap assigns their target form to later phases.

## Task 1: Align Zod And Complete Boundary Contracts

**Files:** `package.json`, `pnpm-workspace.yaml`, `packages/shared/package.json`, `apps/server/package.json`, `pnpm-lock.yaml`, shared HTTP/WS/job contracts and tests, workspace dependency tests, and the server job queue producer/worker boundary.

- [x] Add failing workspace tests proving every workspace consumer resolves Zod major 4 and no package declares Zod 3.
- [x] Add failing contract tests for a single error envelope, context-preserving generation submission/cancellation requests and responses, WS error messages, and parsed queue envelopes with schema version/type/strict payload.
- [x] Run `pnpm test:workspace` and `pnpm --filter @loomic/shared test`; confirm failures identify missing contracts/version alignment.
- [x] Pin Zod 4 in the workspace catalog, explicitly reference it from every source-importing package, implement the schemas/types, and atomically migrate the queue producer/worker with hybrid rolling compatibility, legacy normalization, and authoritative job integrity checks.
- [x] Rebuild shared and run workspace/shared tests, typecheck, and `pnpm dedupe --check`.

## Task 2: Establish AppError And Fastify Error Boundary

**Files:** `packages/shared/src/errors.ts`, `packages/shared/src/http.ts`, `apps/server/src/errors/app-error.ts`, `apps/server/src/http/error-handler.ts`, `apps/server/src/http/error-handler.test.ts`, `apps/server/src/app.ts`

- [x] Write failing injection tests for Zod input errors (400 `invalid_request`), authenticated application errors with stable status/code, unknown errors (500 without internal detail), and request-abort errors.
- [x] Verify the tests fail because routes currently map errors independently.
- [x] Implement `AppError` with code/status/expose/details/cause, shared error-envelope serialization, and a Fastify global handler using request logging with safe structured fields.
- [x] Register the handler before routes and retain Fastify's validation behavior through the same envelope.
- [x] Run the focused tests and existing authorization/security route tests.

## Task 3: Migrate Route Error Mapping

**Files:** `apps/server/src/http/*.ts`, corresponding `*.test.ts` route tests

- [x] Add representative failing tests for projects, canvases, chat, jobs, credits, skills, and payments showing identical error envelopes and status preservation.
- [x] Replace route-local `isZodError`, repeated unauthorized responses, and broad catch/response blocks with thrown `AppError` or service errors normalized at the boundary.
- [x] Keep route adapters responsible only for auth, schema parse, use-case/service call, and response schema serialization.
- [x] Prove by search that no route defines `isZodError` and by tests that phase 0 security error codes/statuses remain stable.

Verification evidence: registered-route regression tests cover projects, canvases, chat, jobs, credits, skills, and payments; strict HTTP source scans enforce parsed external inputs, direct boundary throws with explicit statuses, and no broad catches in pure adapters.

## Task 4: Build Schema-Driven Environment Configuration

**Files:** `packages/config/src/env.ts`, `packages/config/src/index.ts`, `packages/config/src/env.test.ts`, `packages/config/package.json`, `apps/server/src/config/env.ts`, `apps/server/src/config/env.test.ts`, `.env.example`, `railway.json`, `vercel.json`, `scripts/validate-env-template.mjs`, `tests/workspace.test.mjs`

- [x] Write failing tests for invalid ports/ranges/enums/URLs, whitespace normalization, exact boolean parsing, process-specific required settings, safe redaction metadata, and provider-dependent requirements.
- [x] Define environment descriptors and Zod schemas in `@loomic/config`; expose server/API/worker parsing without exporting resolved secrets to browser modules.
- [x] Refactor `loadServerEnv` to parse once and fail with one actionable issue list; retain explicit test overrides through a validated merge.
- [x] Add a validator that parses `.env.example` keys and deployment declarations against descriptors without requiring secret values.
- [x] Run config/server/workspace tests and verify malformed configuration fails before clients/routes/workers are constructed.

Verification evidence: Config 29/29, Server environment 10/10, and Workspace 63/63 tests cover exact parsing, aggregated redacted failures, process/provider requirements, browser import isolation, 53 environment descriptors, deployment declarations, Docker filesystem entrypoints, and fail-fast startup ordering.

## Task 5: Create Explicit Provider And Executor Registries

**Files:** `apps/server/src/generation/providers/registry.ts`, `registry.test.ts`, `register-all.ts`, `apps/server/src/features/jobs/job-executor.ts`, `job-executor.test.ts`, executors under `features/jobs/executors/`, `apps/server/src/app.ts`, `apps/server/src/worker.ts`

- [x] Write failing tests that two registry instances are isolated and duplicate provider names, duplicate model IDs (including across providers), and duplicate executor job types throw descriptive startup errors.
- [x] Implement immutable-after-build `ProviderRegistry` and `ExecutorRegistry` instances with typed lookup/list APIs; remove module-global Maps and import-time executor side effects.
- [x] Make registration functions return fully validated registries and inject them through generation services and worker context.
- [x] Run focused registry tests twice in one process to prove no cross-test/application contamination.

## Task 6: Add SubmitGeneration And CancelGeneration Use Cases

**Files:** `apps/server/src/application/generation/ports.ts`, `submit-generation.ts`, `cancel-generation.ts`, corresponding tests, `apps/server/src/features/jobs/job-service.ts`, `apps/server/src/features/credits/tier-guard.ts`

- [x] Write failing tests for media-specific schema parsing, tier/model validation, job submission, cleanup on pre-queue failure, cancellation ownership, and stable application errors.
- [x] Define separate queued-job submission/cancellation ports plus tier authorization and model resolution; direct synchronous generation remains a separate workflow and no unused synchronous port is introduced. Use cases must not import Fastify, WebSocket, Supabase, or global registries.
- [x] Implement submission/cancellation by composing existing services without changing phase 2 transaction semantics; log operation identifiers and failure stage without prompts/tokens.
- [x] Run focused tests and confirm Task 8 can reuse `SubmitGeneration` for queued HTTP/Agent paths while direct generation keeps its materially different result and lifecycle.

Verification evidence: generation application tests cover shared media schema parsing, ordered model/tier/credit orchestration, post-create cleanup, cancellation delegation, identifier-safe logging, strict normalization of real-shaped legacy service errors, and runtime validation of adapter outcomes. `CancelGeneration` depends only on `GenerationCancellationPort`; queued submission does not expose a direct-generation mode. Task 8 can use the explicit `createJobServiceGenerationPorts` wrapper rather than structurally treating the broader legacy `JobService` result as an application outcome.

## Task 7: Add ApplyCanvasOperations And ImportSkill Use Cases

**Files:** `apps/server/src/application/canvas/apply-canvas-operations.ts`, test, `apps/server/src/application/skills/import-skill.ts`, test, existing canvas and skill services

- [x] Write failing tests for authorization-before-mutation, operation validation, external-import capability gating, review-required result, and error normalization.
- [x] Implement thin application use cases around existing services; do not introduce phase 2 revision semantics or phase 4 node protocols early.
- [x] Provide explicit CanvasService/skill-import adapters for later entry-point migration; no Agent or HTTP path is claimed migrated by this task, and Task 8 retains ownership of replacing their direct writes.
- [x] Run focused application tests and existing Skill security tests.

Verification evidence: application and adapter tests cover ordered canvas authorization, a strict per-action application/engine schema alongside the flat LLM-compatible tool schema, atomic no-save behavior for skipped/mixed batches, cloned input immutability on success/save failure, outcome identity/count validation, safe bounded issues, and stable error normalization. The Agent tool and `CanvasService` adapter call the same transport-neutral engine and both reject partial batches; the Agent still owns its inline load/save until Task 8. Skill tests cover capability-first gating, credential rejection, canonical query/hash-free source identity, review-required/disabled results, fixed mappings for real importer/safe-fetch errors, and URL-secret-free logs on default/GitHub/tarball paths. This task introduces neither canvas revision/node protocols nor a second archive/network importer, and HTTP Skill persistence remains explicitly assigned to Task 8.

## Task 8: Migrate HTTP, WebSocket, Agent, And Worker Entry Points

**Files:** `apps/server/src/app.ts`, `worker.ts`, `http/generate.ts`, `http/jobs.ts`, `http/runs.ts`, `ws/handler.ts`, `agent/runtime.ts`, `agent/tools/image-generate.ts`, `agent/tools/video-generate.ts`, generation executors, integration tests

- [x] Add adapter spy tests showing queued HTTP and Agent image/video paths call the same `SubmitGeneration` interface with shared normalized contracts; HTTP background-job cancellation calls `CancelGeneration`, while WS `agent.cancel` is explicitly tested as `runId`-scoped `AgentRunService.cancelRun` and never background-job cancellation.
- [x] Inject independently composed read-only canvas/skill use cases from the composition root and an optional generation group; delete duplicated queued job/tier/provider orchestration from HTTP and Agent adapters. Build-app tests prove canvas/skill capabilities remain available without `SUPABASE_DB_URL` while queued generation is explicitly unavailable.
- [x] Keep streaming and LangGraph run lifecycle inside Agent runtime, delegate queued generation submission to `SubmitGeneration`, and forward canvas application dependencies through the lazy Agent factory so `manipulate_canvas` is registered from production wiring.
- [x] Ensure Worker retains sealed explicit executor/provider catalogs and route generated media insertion through the application-owned `AttachGeneratedAsset` boundary. ENG-017 remains partial because revision/concurrency/event publication are later work.
- [x] Run server/shared/workspace tests, full typecheck/build/lint/diff checks, and architecture searches for adapter-level `createJob`/`cancelJob`, direct Skill importer access, direct manipulate-tool Supabase canvas access, and runtime direct media-writer access.

Task 8 evidence: `entrypoint-architecture.test.ts`, `jobs.application-wiring.test.ts`, `runtime.application-wiring.test.ts`, `handler.authorization.test.ts`, and `app.env.test.ts` cover the migrated boundaries and missing-generation composition. The truly synchronous `/api/agent/generate-image` path remains deliberately separate under Task 6 scope because its immediate media result and lifecycle are incompatible with the queued submission contract; only the queued video portion of `generate.ts` migrated here.

## Task 9: Build The Web Schema-Aware Fetcher

**Files:** `apps/web/src/lib/api-client.ts`, `api-client.test.ts`, `server-api.ts`, `apps/web/test/server-api.test.ts`, shared HTTP contracts

- [x] Write failing tests for successful schema parsing, malformed JSON, structurally invalid success payloads, error-envelope parsing, 401 specialization, timeout, caller abort, and empty 204 responses.
- [x] Implement a typed fetcher accepting method/path/access token/request schema/response schema/timeout/signal; combine timeout and caller abort without leaking timers.
- [x] Migrate every `server-api.ts` helper from unchecked `response.json() as T` to the fetcher and shared schemas while preserving exported helper signatures.
- [x] Prove by search that `server-api.ts` contains no response type assertions and run all Web tests.

## Task 10: Architecture And Contract Enforcement

**Files:** `tests/workspace.test.mjs`, `package.json`, `biome.json` or a focused architecture script

- [x] Add failing architecture tests forbidding module-global registries, route-local Zod duck typing, unchecked Web response casts, and direct job orchestration from migrated adapters.
- [x] Add the architecture test to `ci:check` through the existing workspace test command.
- [x] Run `pnpm test:workspace`, then intentionally confirm each rule points to actionable file/line evidence before restoring green state.

Verification evidence: TypeScript-AST rules cover alias/namespace and namespaced-call bypasses, ignore comments/string/template false positives, fail closed on malformed TypeScript, and report actionable file/line diagnostics. The real-source enforcement test and 37 negative fixtures run through `test:workspace` and therefore `ci:check`.

## Task 11: Documentation And Strict Acceptance

**Files:** `docs/tech/engineering-issues-register.md`, `docs/tech/phase-1-verification.md`, `.codemap/`, plan checklist

- [x] Run focused unit/contract/adapter tests with cache disabled, then `pnpm ci:check --force` or equivalent uncached package commands.
- [x] Run `supabase db reset --yes`, `supabase test db`, Docker build, and container `dist/app.js` load smoke test.
- [x] Run `git diff --check`, architecture searches, `pnpm why zod`, and verify no new Biome warnings beyond the recorded baseline.
- [x] Update each covered ENG item conservatively as solved/partially solved with commit and test evidence; do not close items whose target architecture belongs to later phases.
- [x] Record exact commands, test counts, environment-independent results, known deferred items, commit SHA, and acceptance conclusion in `phase-1-verification.md`.

Acceptance evidence: `docs/tech/phase-1-verification.md` records the uncached 458-test evidence, exact warning baseline, Supabase CLI 2.114.0 reset and 14 database tests, the `loomic-server:phase1` build, app-module import, and Railway entrypoint target/image-layout/syntax consistency checks, dependency audit (including the isolated `shadcn` build-tool Zod 3 graph), architecture scope, implementation SHA, and deferred Phase 2/3/4 work. These container checks do not claim that API/Worker process startup was exercised.

## Acceptance Matrix

| Requirement | Evidence |
| --- | --- |
| One Zod major for Loomic contract consumers | manifests, lockfile, `pnpm why zod`, workspace test; isolated `shadcn` build-tool graph documented |
| Shared HTTP/WS/queue contracts | shared contract tests and adapter parsing tests |
| Unified errors | global handler tests and absence of route-local Zod mapping |
| Fail-fast configuration | config matrix tests and template/deployment validator |
| Explicit registries | duplicate/isolation tests and composition-root injection |
| Shared use cases | adapter spy tests plus architecture searches |
| Web response validation | malformed-payload/abort/timeout tests and no unchecked casts |
| Production delivery gates retained | uncached quality and DB gates, Docker image build, app-module import, Railway entrypoint target/image-layout/syntax consistency, and diff checks; API/Worker process startup is not claimed |
