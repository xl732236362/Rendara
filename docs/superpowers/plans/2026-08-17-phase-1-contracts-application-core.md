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

- [ ] Write failing tests for invalid ports/ranges/enums/URLs, whitespace normalization, exact boolean parsing, process-specific required settings, safe redaction metadata, and provider-dependent requirements.
- [ ] Define environment descriptors and Zod schemas in `@loomic/config`; expose server/API/worker parsing without exporting resolved secrets to browser modules.
- [ ] Refactor `loadServerEnv` to parse once and fail with one actionable issue list; retain explicit test overrides through a validated merge.
- [ ] Add a validator that parses `.env.example` keys and deployment declarations against descriptors without requiring secret values.
- [ ] Run config/server/workspace tests and verify malformed configuration fails before clients/routes/workers are constructed.

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

Verification evidence: generation application tests cover shared media schema parsing, ordered model/tier/credit orchestration, post-create cleanup, cancellation delegation, identifier-safe logging, and strict normalization of real-shaped legacy service errors. `CancelGeneration` depends only on `GenerationCancellationPort`; queued submission does not expose a direct-generation mode.

## Task 7: Add ApplyCanvasOperations And ImportSkill Use Cases

**Files:** `apps/server/src/application/canvas/apply-canvas-operations.ts`, test, `apps/server/src/application/skills/import-skill.ts`, test, existing canvas and skill services

- [ ] Write failing tests for authorization-before-mutation, operation validation, external-import capability gating, review-required result, and error normalization.
- [ ] Implement thin application use cases around existing services; do not introduce phase 2 revision semantics or phase 4 node protocols early.
- [ ] Ensure Agent tools and HTTP adapters depend on the use-case interfaces rather than direct Supabase writes for paths migrated in this phase.
- [ ] Run focused application tests and existing Skill security tests.

## Task 8: Migrate HTTP, WebSocket, Agent, And Worker Entry Points

**Files:** `apps/server/src/app.ts`, `worker.ts`, `http/generate.ts`, `http/jobs.ts`, `http/runs.ts`, `ws/handler.ts`, `agent/runtime.ts`, `agent/tools/image-generate.ts`, `agent/tools/video-generate.ts`, generation executors, integration tests

- [ ] Add failing adapter tests showing HTTP and Agent call the same `SubmitGeneration` fake and HTTP/WS call the same cancellation boundary.
- [ ] Inject application use cases from composition roots; delete duplicated job/tier/provider orchestration from adapters.
- [ ] Keep streaming/run lifecycle inside Agent runtime, but delegate generation submission and cancellation semantics to application use cases.
- [ ] Ensure worker uses explicit executor/provider registries and application-owned canvas mutation interfaces.
- [ ] Run all server tests and search for adapter-level `createJob`/`cancelJob` orchestration outside approved application/infrastructure files.

## Task 9: Build The Web Schema-Aware Fetcher

**Files:** `apps/web/src/lib/api-client.ts`, `api-client.test.ts`, `server-api.ts`, `apps/web/test/server-api.test.ts`, shared HTTP contracts

- [ ] Write failing tests for successful schema parsing, malformed JSON, structurally invalid success payloads, error-envelope parsing, 401 specialization, timeout, caller abort, and empty 204 responses.
- [ ] Implement a typed fetcher accepting method/path/access token/request schema/response schema/timeout/signal; combine timeout and caller abort without leaking timers.
- [ ] Migrate every `server-api.ts` helper from unchecked `response.json() as T` to the fetcher and shared schemas while preserving exported helper signatures.
- [ ] Prove by search that `server-api.ts` contains no response type assertions and run all Web tests.

## Task 10: Architecture And Contract Enforcement

**Files:** `tests/workspace.test.mjs`, `package.json`, `biome.json` or a focused architecture script

- [ ] Add failing architecture tests forbidding module-global registries, route-local Zod duck typing, unchecked Web response casts, and direct job orchestration from migrated adapters.
- [ ] Add the architecture test to `ci:check` through the existing workspace test command.
- [ ] Run `pnpm test:workspace`, then intentionally confirm each rule points to actionable file/line evidence before restoring green state.

## Task 11: Documentation And Strict Acceptance

**Files:** `docs/tech/engineering-issues-register.md`, `docs/tech/phase-1-verification.md`, `.codemap/`, plan checklist

- [ ] Run focused unit/contract/adapter tests with cache disabled, then `pnpm ci:check --force` or equivalent uncached package commands.
- [ ] Run `supabase db reset --yes`, `supabase test db`, Docker build, and container `dist/app.js` load smoke test.
- [ ] Run `git diff --check`, architecture searches, `pnpm why zod`, and verify no new Biome warnings beyond the recorded baseline.
- [ ] Update each covered ENG item conservatively as solved/partially solved with commit and test evidence; do not close items whose target architecture belongs to later phases.
- [ ] Record exact commands, test counts, environment-independent results, known deferred items, commit SHA, and acceptance conclusion in `phase-1-verification.md`.

## Acceptance Matrix

| Requirement | Evidence |
| --- | --- |
| One Zod major | manifests, lockfile, `pnpm why zod`, workspace test |
| Shared HTTP/WS/queue contracts | shared contract tests and adapter parsing tests |
| Unified errors | global handler tests and absence of route-local Zod mapping |
| Fail-fast configuration | config matrix tests and template/deployment validator |
| Explicit registries | duplicate/isolation tests and composition-root injection |
| Shared use cases | adapter spy tests plus architecture searches |
| Web response validation | malformed-payload/abort/timeout tests and no unchecked casts |
| Production readiness retained | uncached quality, DB, Docker, container, and diff gates |
