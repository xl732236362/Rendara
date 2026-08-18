# Phase 3 Agent and Skill Security Design

> **Status: Superseded.** Retained only as decision history. Do not implement this design. The authoritative Phase 3 design is `2026-08-18-builtin-skills-and-canvas-scoped-agent-design.md`, which removes external/user Skills instead of building revision and approval infrastructure.

**Status:** Superseded
**Goal:** Prevent untrusted prompts, model output, and external Skills from escaping the application boundary while preserving explicitly authorized production capabilities.

## Scope

Phase 3 delivers seven ordered workstreams:

1. Capability contracts and deny-by-default policy.
2. Provider-neutral sandbox lifecycle abstraction.
3. Production isolated execution provider and resource/network limits.
4. Immutable Skill revisions, hashes, manifests, and requested capabilities.
5. Skill review, approval, enable, disable, and revoke state machine.
6. Agent runtime integration, per-run capability snapshots, and audit logging.
7. Security regression tests, verification evidence, and operations runbook.

## Architecture

The composition root resolves a `CapabilitySnapshot` for each Agent run. Every tool and sandbox operation receives that snapshot and fails closed when a capability is absent. Production execution uses a `SandboxProvider`; the existing local backend remains development-only and production continues to reject execution when no isolated provider is configured.

Skills are immutable revisions. Import records canonical source identity, revision/integrity hash, file manifest, trust level, and requested capabilities. External revisions start as `pending_review` and `disabled`; content changes create a new revision and invalidate approval. Only an approved, enabled revision may enter the Agent runtime.

### Execution boundary

`SandboxProvider` is the only process-execution port. It creates a lease and returns a restricted DeepAgents `BackendProtocol` adapter; the adapter forwards command/file operations to the lease and never exposes provider credentials to the Agent. StoreBackend remains the durable source for `/workspace/`, `/memories/`, and approved Skill metadata. `/sandbox/` is the only remote working area. `persist_sandbox_file` downloads through the provider port and then calls the asset application use case. Streaming output is correlated by `runId` and `leaseId`.

The provider contract is:

```ts
createLease(input: { runId: string; policy: SandboxPolicy }): Promise<{
  leaseId: string;
  enforcedPolicy: EnforcedSandboxPolicy;
  backend: BackendProtocol;
}>;
destroyLease(input: { leaseId: string; idempotencyKey: string }): Promise<void>;
```

The first production adapter is an HTTPS remote-sandbox adapter configured with `LOOMIC_SANDBOX_PROVIDER_URL`, an opaque provider token, and a health/capability handshake endpoint. Its API must support lease creation, command/file RPC, streamed output, and idempotent destruction; provider-specific payloads stay inside the adapter. Startup rejects a provider whose `enforcedPolicy` is weaker than the required policy. The API owns the lease during a run, performs idempotent cleanup in `finally`, and a restart watchdog reconciles orphan leases. LocalShellBackend is available only in development mode; production has no local fallback.

The required policy is explicit: `rootless=true`, `readOnlyRoot=true`, `networkDefaultDeny=true`, `egressAllowlist=true`, `maxWallTimeSeconds=120`, `maxMemoryMb=512`, `maxPids=128`, and `maxDiskMb=1024`. The provider must return these effective values in its handshake and lease response; missing fields or weaker values fail closed.

### Capability enforcement

Capability checks are enforced at application use-case ports, not only in Agent tools. Every high-risk use case (`execute`, external fetch, generation, asset persistence, Skill load, canvas mutation) receives a `SecurityContext` containing the immutable snapshot and performs `requireCapability()` before any side effect. Agent tools, HTTP routes, WebSocket handlers, and provider adapters all call the same use-case ports. A bypass test calls each port directly and must still be denied.

### Skill data model

`skill_revisions` is the immutable artifact source. It stores `source_url`, `source_revision`, `source_digest`, `artifact_digest`, canonical manifest, file manifest, trust level, and requested capabilities. `workspace_skill_installations` points to a revision and stores workspace-local enabled/revoked state. `skill_reviews` stores reviewer, role, decision, reviewed artifact digest, and timestamp. Existing `skills`/`skill_files` and `workspace_skills` remain compatibility projections during migration: all reads and writes in `http/skills.ts`, `http/skills-marketplace.ts`, and `agent/workspace-skills.ts` are switched to a revision-aware application port in the same phase, and compatibility rows are generated from the selected revision. No route may mutate legacy content independently.

Artifact digest is SHA-256 over canonical manifest bytes followed by sorted `filePath + NUL + byteLength + contentDigest` records. Mutable branch/tag sources without a resolved immutable revision are rejected. Trusted publishers may attach a detached signature over the artifact digest; the trust policy records publisher key id and verification result. Community revisions without a valid signature remain reviewable but cannot request high-risk capabilities. Approval is workspace-local; only a workspace owner/admin who is not the importer may approve, and a changed digest automatically returns to `pending_review`.

## Security invariants

- No production shell executes in the API or Worker container.
- Sandbox processes are non-root, time/resource limited, network-deny by default, and destroyed after use.
- Private, loopback, link-local, metadata, and unauthorized egress targets are blocked.
- Capability checks happen before tool/provider side effects.
- Skill hash, approval, workspace ownership, and enabled state are checked at load time.
- Audit events are append-only and include tenant, user, run, skill revision, capability decision, and sandbox lifecycle identifiers.

## Data and failure behavior

Add revision, workspace installation, review, capability, sandbox run, and audit event records with RLS, append-only triggers, and uniqueness constraints. Stable errors distinguish `capability_denied`, `skill_not_approved`, `skill_revision_changed`, `sandbox_unavailable`, `sandbox_timeout`, and `sandbox_resource_limit`. Audit events include the enforced policy and provider lease identifiers.

If policy resolution, source verification, sandbox creation, or cleanup is uncertain, the request fails closed. Cleanup is retried idempotently and any unresolved cleanup is surfaced as an audit/operations alert.

## Verification

The phase is complete only when capability, lifecycle, network, credential isolation, Skill revision/approval, cross-workspace authorization, bypass resistance, restart recovery, orphan cleanup, and audit completeness tests pass. Verification must include blocked reads of `/proc`, `/etc/shadow`, mounted credentials and metadata IPs; DNS/retry redirect checks; symlink escape checks; and evidence of the provider's enforced policy. The phase-3 verification/runbook documents production configuration and incident handling.
