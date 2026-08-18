# Phase 3 Agent and Skill Security Implementation Plan

> **Status: Superseded and not executable.** The product no longer supports external or user-defined Skills. Replace this plan from the authoritative `docs/superpowers/specs/2026-08-18-builtin-skills-and-canvas-scoped-agent-design.md`; do not execute its Skill revision, approval, or compatibility tasks.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deny-by-default capability model, isolated production sandbox boundary, and immutable Skill supply-chain approval flow.

**Architecture:** Resolve an immutable capability snapshot at Agent-run creation. Route execution through a provider-neutral sandbox interface and require an isolated provider in production. Treat each imported Skill as an immutable, hash-addressed revision whose approval and enabled state are checked before runtime loading.

**Tech Stack:** TypeScript, Fastify, LangGraph/DeepAgents backends, Supabase/PostgreSQL migrations, Zod, Vitest.

---

### Task 1: Capability contract and policy resolver

**Files:**
- Create: `packages/shared/src/capability-contracts.ts`
- Modify: `packages/shared/src/index.ts`
- Create: `apps/server/src/application/security/capability-policy.ts`
- Test: `apps/server/src/application/security/capability-policy.test.ts`

- [ ] Write tests for deny-by-default, deterministic merge, conflict denial, and immutable snapshots.
- [ ] Implement shared capability enums/schemas and server policy resolution with stable decision reasons and structured logging.
- [ ] Run `pnpm --filter @loomic/server test -- capability-policy`.

### Task 2: Sandbox provider boundary

**Files:**
- Create: `apps/server/src/agent/sandbox/provider.ts`
- Create: `apps/server/src/agent/sandbox/fake-provider.ts`
- Create: `apps/server/src/agent/sandbox/backend-adapter.ts`
- Modify: `apps/server/src/agent/backends/index.ts`
- Test: `apps/server/src/agent/sandbox/provider.test.ts`

- [ ] Write lifecycle tests for create, execute, timeout, idempotent destroy, and unavailable provider.
- [ ] Implement the provider-neutral lease/execute/destroy contract, enforced-policy handshake, DeepAgents backend adapter, and deterministic fake provider.
- [ ] Make backend composition depend on the provider interface, preserving state-only production behavior when execution is disabled.

### Task 3: Production isolation provider

**Files:**
- Create: `apps/server/src/agent/sandbox/isolated-provider.ts`
- Modify: `apps/server/src/agent/backends/prod.ts`
- Modify: `apps/server/src/config/env.ts`
- Modify: `.env.example`
- Test: `apps/server/src/agent/sandbox/isolated-provider.test.ts`

- [ ] Write tests proving the required policy (`rootless`, read-only root, network default deny, egress allowlist, 120s wall time, 512MB memory, 128 PIDs, 1GB disk) and fail-closed startup when any field is missing or weaker.
- [ ] Implement the HTTPS remote provider adapter (`LOOMIC_SANDBOX_PROVIDER_URL` plus opaque token) with health/capability handshake, lease creation, command/file RPC, streamed output, idempotent destruction, and lifecycle audit hooks. Reject startup when required policy fields are not enforced; never treat the fake provider as production-ready.
- [ ] Reject production `execute` when an isolated provider is not configured; never fall back to `LocalShellBackend`.

### Task 4: Immutable Skill revisions and capabilities

**Files:**
- Create: `supabase/migrations/20260818000005_phase3_skill_revisions.sql`
- Create: `supabase/migrations/20260818000006_phase3_sandbox_audit.sql`
- Modify: `packages/shared/src/skill-contracts.ts`
- Modify: `apps/server/src/application/skills/import-skill.ts`
- Modify: `apps/server/src/http/skills-marketplace.ts`
- Modify: `apps/server/src/agent/workspace-skills.ts`
- Test: `apps/server/src/application/skills/skill-revision.test.ts`

- [ ] Write tests for canonical source identity, immutable revision resolution, canonical artifact digest (manifest plus sorted files), detached signature/trust policy, digest uniqueness, manifest limits, and hash-change detection.
- [ ] Add immutable `skill_revisions`, workspace-local `workspace_skill_installations`, and revision capability/trust/manifest persistence with RLS; retain existing `skills`/`skill_files` as compatibility projections.
- [ ] Add compatibility projection/backfill and prevent direct legacy mutations; route all Skill reads/writes through a revision-aware port.
- [ ] Return revision metadata from import and reject mutable/unverifiable sources.
- [ ] Store publisher key id/signature verification and deny high-risk capabilities for unsigned community revisions.

### Task 5: Skill review state machine

**Files:**
- Create: `apps/server/src/application/skills/skill-review.ts`
- Modify: `apps/server/src/application/use-cases.ts`
- Modify: `apps/server/src/http/skills.ts`
- Modify: `apps/server/src/http/skills-marketplace.ts`
- Test: `apps/server/src/application/skills/skill-review.test.ts`

- [ ] Write transition tests for imported -> pending_review -> approved -> enabled, plus disable/revoke and changed-content re-review.
- [ ] Implement owner/admin-only workspace-local transitions with stable errors and audit records; external imports remain disabled by default. A changed digest invalidates prior approval, and revoke blocks new runs.
- [ ] Expose review/enable operations through validated HTTP contracts with workspace authorization.

### Task 6: Agent runtime integration and audit

**Files:**
- Modify: `apps/server/src/agent/runtime.ts`
- Modify: `apps/server/src/agent/workspace-skills.ts`
- Modify: `apps/server/src/agent/tools/index.ts`
- Create: `apps/server/src/agent/security/run-security-context.ts`
- Modify: `apps/server/src/application/use-cases.ts`
- Modify: `apps/server/src/features/credits/credit-service.ts`
- Test: `apps/server/src/agent/runtime.security.test.ts`

- [ ] Write tests for per-run snapshots, unapproved/revoked Skill rejection, capability checks before side effects, and cleanup on failure.
- [ ] Resolve Skill revisions and capabilities before runtime construction and inject the security context into tools/backend.
- [ ] Put `requireCapability()` at application use-case ports for execution, network fetch, generation, asset persistence, Skill load, and canvas mutation; test direct-port bypasses.
- [ ] Replace direct `sandboxDir` deletion with lease ownership, idempotent `finally` cleanup, restart watchdog reconciliation, and structured lifecycle/denial logs.

### Task 7: Database audit, verification, and operations

**Files:**
- Modify: `supabase/migrations/20260818000005_phase3_skill_revisions.sql`
- Modify: `supabase/migrations/20260818000006_phase3_sandbox_audit.sql`
- Create: `supabase/tests/phase_3_security.test.sql`
- Create: `docs/tech/phase-3-verification.md`
- Modify: `docs/tech/engineering-issues-register.md`
- Modify: `docs/tech/phase-2-operations-runbook.md`

- [ ] Add SQL tests for RLS, revision/digest uniqueness, append-only audit behavior, owner/admin review authority, revoke enforcement, and cross-workspace isolation.
- [ ] Run focused tests, server tests, workspace checks, and security SQL tests; record exact commands and evidence.
- [ ] Mark ENG-027/ENG-030 resolved only after isolated-provider and Skill supply-chain acceptance criteria pass; otherwise record remaining gaps explicitly.

### Completion gate

- [ ] `pnpm ci:check` passes.
- [ ] Production configuration cannot instantiate a local shell execution backend.
- [ ] Required provider policy is proven enforced at runtime; missing/weak enforcement fails closed.
- [ ] All phase-3 security and SQL tests pass.
- [ ] Verification and operations documents contain deployment, rollback, and incident steps.
