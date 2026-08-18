# Phase 3 Amendment: Built-in Skills and Canvas-scoped Agent

**Status:** Approved; authoritative Phase 3 design
**Date:** 2026-08-18
**Goal:** Reduce the current governance surface by removing user-extensible Skills and restricting every Agent run to its current canvas and explicitly authorized server capabilities.

## Decision

Loomic will not support user-created, imported, downloaded, installed, or workspace-configurable Skills. Skills are internal product assets stored in the repository, reviewed with application code, and released with the server. Existing custom Skill data is deleted without preservation, export, conversion, or recovery support.

This document is the authoritative Phase 3 design under the platform governance plan. It supersedes the earlier Phase 3 Skill supply-chain design and implementation plan in full. Those obsolete files are removed; Git history is the decision record. The deny-by-default sandbox and capability-enforcement requirements that remain applicable are restated here.

## Scope

The change removes:

- Skill creation, editing, deletion, URL import, marketplace search, marketplace installation, workspace installation, enable/disable, and uninstall user experiences.
- HTTP routes, application ports, adapters, rate limits, environment settings, contracts, tests, and dependencies used only by those experiences.
- Database tables, policies, triggers, functions, and stored data used by the dynamic Skill registry and workspace installations.
- Runtime loading of Skill content or files from Supabase, request input, user storage, or external sources.

The change retains:

- Repository-owned Skill packages under the server-controlled built-in Skills root.
- Internal Skill metadata and files needed by DeepAgents middleware.
- The existing canvas, generation, asset, brand-kit, and project capabilities when explicitly granted by server policy.

## Built-in Skill Architecture

The repository `skills/` directory is the only authoring source. A versioned `skills/builtin-skills.manifest.json` explicitly lists every built-in Skill directory and its required capabilities. The packaged manifest path and Skill root are resolved from the application artifact, not from an environment variable or request. Tests inject a fixture catalog rather than weakening production validation.

The manifest schema is closed and versioned: the root contains only `schemaVersion: 1` and `skills`; each entry contains only `name`, repository-relative `path`, and a `requiredCapabilities` array drawn from the server capability enum. The array may be empty for read-only guidance. For example, `canvas-design` requires `sandbox.files.read`, `sandbox.files.write`, `sandbox.execute`, and `asset.persist`, while `json-image-prompt` requires `image.generate`. Unknown fields, unknown schema versions, unknown capability names, duplicate paths, and mismatches between manifest name and Skill frontmatter fail validation. Skill declarations describe prerequisites but never grant them.

At process startup, the composition root reads only manifest entries, validates them, and copies their bytes into an immutable, read-only virtual `/skills/` backend. It never routes `/skills/` to the authoring directory or another host filesystem path. Directory discovery therefore cannot grant eligibility, and unlisted repository files are not readable by the Agent. Validation requires:

- Directory name and manifest identity must match.
- Every regular file recursively enumerated beneath a listed Skill directory must remain inside that directory and the packaged Skills root after path resolution.
- Agent Skills frontmatter contains a unique valid `name` and non-empty `description` and follows the supported package schema.
- Names match `^[a-z0-9]+(?:-[a-z0-9]+)*$` and are at most 64 characters; descriptions are at most 1,024 characters.
- The catalog contains at most 32 Skills and 64 MB total; each Skill contains at most 256 regular files and 10 MB total; `SKILL.md` is at most 256 KB and every supporting file is at most 10 MB. Text and binary resources retain their media type and bytes.
- Duplicate names, invalid paths, symbolic links/reparse points, unreadable files, and malformed metadata fail startup in every environment.
- The loaded catalog is immutable for the lifetime of the process.

The composition root constructs the catalog once. After resolving a run's capability snapshot, the server creates a read-only virtual view containing only entries whose `requiredCapabilities` are a subset of that snapshot. It injects that view into the Agent factory and, with the repository's supported `deepagents` version, passes `skills: ["/skills/"]` to `createDeepAgent`, allowing the official `SkillsMiddleware` to perform progressive disclosure. Loomic does not duplicate Skill discovery by manually appending metadata to the system prompt. A client or run cannot add, replace, enable, disable, or select Skills; server-side capability filtering is mandatory. The catalog must never be populated from workspace or user data.

The catalog identity is SHA-256 over the RFC 8785 canonical manifest bytes followed by every included file in lexicographic relative-path order, encoded as `path + NUL + byteLength + NUL + SHA256(fileBytes)`. Logs and persisted Agent runs record that identity and the loaded Skill names, allowing a run to be tied to the exact deployed catalog without reintroducing an external revision system. Sandbox upload verification recomputes the same file records for the effective Skill view and compares them with the startup catalog entries.

Internal developers add or update a Skill through a normal code change. Code review, automated validation, repository history, and deployment rollback provide the governance lifecycle.

## Ownership Boundaries

- `BuiltinSkillCatalog` owns manifest parsing, package validation, immutable bytes, catalog digest, capability filtering, and the read-only backend. It depends only on filesystem input during startup and exposes no mutation API.
- `AcceptAgentRun` owns canonical canvas/session authorization, capability resolution, effective Skill selection, durable context persistence, and publication to the runtime.
- `AgentCapabilityPolicy` owns the closed server-only capability enum, policy version, tool/backend/subagent mapping, and deny decisions. Public request contracts cannot represent grants.
- `SandboxProvider` owns remote lease lifecycle and implements the DeepAgents sandbox backend protocol without exposing provider credentials.
- Existing canvas, generation, brand-kit, search, and asset application ports remain owners of business authorization and side effects; Agent adapters cannot replace them.

The run data flow is ordered: authenticate request; resolve canonical canvas/project/workspace and session consistency; compute the capability snapshot and effective Skill view; persist the accepted execution context; publish and stream the run. When execution is granted, runtime construction creates the isolated lease, uploads validated Skill resources, builds the capability-aware tool/backend graph, and guarantees cleanup after streaming. Any failed step stops the later steps.

## Agent Authorization Boundary

Every Agent run is canvas-scoped. An accepted run must contain a non-empty `canvasId`; session- or conversation-only execution is rejected. Before the run is created, the HTTP or WebSocket boundary verifies that the authenticated user can access that canvas. The runtime then carries an immutable `AgentExecutionContext` containing:

```ts
interface AgentExecutionContext {
  runId: string;
  userId: string;
  workspaceId: string;
  canvasId: string;
  capabilities: readonly AgentCapability[];
  capabilityPolicyVersion: string;
  skillCatalogDigest: string;
  effectiveSkillNames: readonly string[];
}
```

The server derives and persists this context before acknowledging the run, using only authenticated canvas/project/workspace relationships, deployment policy, and configured provider availability. Client input can request an operation but cannot grant a capability or override any context identifier. Prompts, model output, and Skill content are never capability authorities. A resumed or retried run may keep its original grants only after intersecting them with the current deployment policy and current resource authorization; it can lose capabilities but never gain new ones implicitly.

The shared run-create contract therefore requires `canvasId`; adapters may not silently infer or substitute `conversationId`. Authorization resolves the canonical project and workspace from that canvas and verifies any supplied session/thread belongs to the same scope before constructing the context. The accepted run record stores these canonical identifiers rather than trusting their request values.

Run acceptance is one application use case: it resolves authorization and policy, persists the accepted run plus execution context, and only then publishes the run to the in-process/streaming runtime and returns an acknowledgement. Persistence failure produces no accepted or executable run. HTTP and WebSocket adapters call this same use case.

Application tools, framework-provided tools, middleware, backend routes, and subagents are all constructed from the same server-owned capability map. An application tool is absent when its capability is not granted. DeepAgents filesystem operations are constrained by a capability-aware backend and ordered permissions. The `task` tool is absent unless delegation is granted; every subagent receives the same execution context and no broader capability set. High-risk application ports also revalidate current resource access and call the shared capability guard before side effects, so a stale snapshot or direct invocation cannot bypass the boundary. Tools that affect canvas or project state receive the bound execution context; they do not accept a caller-selected canvas or workspace identifier.

Initial capability identifiers are deliberately narrow:

- `canvas.read`
- `canvas.mutate`
- `agent.files.read`
- `agent.files.write`
- `agent.delegate`
- `sandbox.files.read`
- `sandbox.files.write`
- `asset.persist`
- `image.generate`
- `video.generate`
- `brand_kit.read`
- `project.search`
- `sandbox.execute`, only when the configured sandbox policy permits it

Capability resolution intersects three server-owned inputs: the deployment allowlist, capabilities supported by configured providers or the isolated sandbox, and capabilities valid for the authorized canvas/project/workspace. A capability is granted only when all required inputs allow it. Capability resolution fails closed. Missing context, failed ownership resolution, unknown capability names, unavailable providers, and inconsistent canvas/workspace relationships reject the run or tool call before side effects.

The capability snapshot and effective Skill names are sorted, deduplicated, and frozen. `capabilityPolicyVersion` is the SHA-256 digest of the canonical deployment allowlist, provider capability declarations, resource-policy rules, and complete tool/backend/subagent mapping. Any policy or mapping change therefore creates a new version and cannot be hidden behind a reused label.

The minimum tool mapping is explicit:

- `canvas.read` gates canvas inspection and screenshot RPCs; screenshot persistence also requires `asset.persist`.
- `canvas.mutate` gates only the bound canvas application port.
- `agent.files.read` permits `ls`, `glob`, `grep`, and `read_file` under the bound `/workspace/` and `/memories/`; `/skills/` is always readable but immutable.
- `agent.files.write` permits file creation/edit under the bound `/workspace/` and `/memories/`, never `/skills/`.
- `sandbox.files.read` and `sandbox.files.write` permit operations only in the current run lease's ephemeral working directory. They are unavailable without an isolated lease in production and never expose host paths.
- `agent.delegate` gates `task`; subagent-specific tools remain subject to their own capabilities, including `video.generate`.
- `sandbox.execute` gates `execute`; no backend implementing execute is supplied without it.
- `image.generate` and `video.generate` gate their canonical generation-submission use cases, including subagent calls; job ownership and any resulting canvas effect use the bound execution context rather than tool input.
- `brand_kit.read` resolves only the brand kit of the bound canvas's canonical project.
- `project.search` searches only the bound canvas namespace; it does not accept a project, workspace, or filesystem root from tool input.
- `asset.persist` writes only through the canonical asset application port using the bound canvas/project/workspace.

Framework state tools such as todo management may remain available only when they have no external side effect and cannot access another resource. Every other automatically supplied tool must appear in the capability map or be disabled. Tests enumerate the effective tool set so a DeepAgents upgrade cannot silently add authority.

Canvas browser RPCs carry both `userId` and the bound `canvasId` and route only to connections currently authorized and bound to that canvas. Routing by user identity alone is insufficient because one user may have several canvases open.

## Isolated Execution Boundary

Removing external Skills reduces supply-chain risk but does not make model-directed code execution trusted. Production `sandbox.execute` remains disabled unless a provider-neutral sandbox adapter proves the required policy at startup and lease creation: isolated per-run filesystem and identity, non-root execution, read-only root, at most one vCPU, 120 seconds per command, a 15-minute hard lease TTL, a 2-minute idle TTL, 512 MB memory, 128 PIDs, 1 GB writable disk, 200 KB captured output per command, all network egress disabled, no application credentials or internal network route, and idempotent cleanup. Phase 3 defines no sandbox network capability because the approved built-in Skills do not require one. Missing or weaker effective-policy fields fail startup and lease creation. Production never falls back to a local shell. Development-only local execution remains behind an explicit environment gate and is never considered a production capability.

Leases boot from a pinned immutable image digest, never a floating tag. The image contains the exact Python runtime and offline Pillow/reportlab dependencies required by `canvas-design`; the Agent cannot install packages or alter the base image. The expected image digest is deployment policy, the provider must report the effective digest, and the lease is rejected on mismatch. Image digest and dependency/SBOM evidence are recorded in Phase 3 verification.

The provider-neutral port exposes `createLease`, an official DeepAgents `SandboxBackendProtocol` for file/execute operations, `destroyLease`, and an idempotent orphan-list/cleanup operation. The implementation plan must name one mature remote provider and prove through its real capability response that it enforces every required field; a fake adapter exists only for deterministic tests. Phase 3 cannot be declared complete by leaving production execute disabled or using the fake provider because the manifest-listed `canvas-design` capability requires isolated execution.

The sandbox lease is created for one `runId` and destroyed in `finally`; idempotent cleanup is retried and an orphan reconciler handles process interruption. The provider backend is the only execution and sandbox-file port. Built-in Skill resources needed by a run are uploaded from the validated in-memory catalog after lease creation, preserving `/skills/<name>/...`, verified against the catalog digest, and made read-only to the sandbox user. They are never mounted from the API host. Agent file tools and sandbox execution therefore use the same stable Skill paths; built-in instructions must not reference host paths or depend on `LOOMIC_SKILLS_ROOT`/`FONT_DIR` path injection.

Sandbox output is retrieved through `downloadFiles`, limited to 50 MB, checked for path containment and symlinks, assigned a server-generated filename, and accepted only when both declared type and magic bytes match PNG, JPEG, WebP, or PDF. SVG, executable formats, archives, and unknown types are rejected. Valid output is persisted through the bound `asset.persist` application port. Access tokens and provider credentials are never passed into sandbox environment variables or files.

Minimal durable records support enforcement and recovery: the accepted Agent run stores its execution context, while each sandbox lease stores `runId`, opaque provider lease ID, effective policy and image digest, status, creation/expiry timestamps, cleanup attempts, and last cleanup error. Lease records contain no provider credentials. The orphan reconciler claims expired active leases idempotently and records the terminal cleanup result.

## Data Removal

A forward-only migration deletes existing custom and system Skill installation data, then drops the dynamic Skill schema in dependency order. No archive table, compatibility view, or restore path is created. This is an explicit exception to the governance plan's normal independent-rollback requirement because the product has decided permanently to remove user-extensible Skills before production launch.

Deployment is a coordinated two-step forward-only release. Release A depends only on the validated built-in catalog and removes every dynamic Skill route while leaving the now-unused tables in place. After runtime telemetry and architecture checks prove there are no dynamic Skill reads or writes, Release B applies the destructive schema migration. This temporary unused schema is a deployment safety step, not a compatibility API. Failures after Release B use forward fixes, not restoration of the removed feature.

Historical migrations remain unchanged. The new migration moves any upgraded environment to the new model, while fresh environments reach the same final schema after all migrations run.

## User Experience

The Skills navigation item and Skills workspace page are removed. There is no replacement management screen because built-in Skills are implementation details, not user-configurable features. User-facing Agent behavior continues through the canvas and chat surfaces.

Requests to removed endpoints return the normal route-not-found response. No hidden or disabled endpoint remains for backward compatibility.

## Logging and Failure Behavior

Structured logs cover:

- Built-in catalog startup validation and catalog identity.
- Run authorization with `runId`, `userId`, `workspaceId`, and `canvasId`.
- Granted capability names and rejected capability decisions.
- Tool name, bound canvas, result status, and sanitized failure code.
- Attempts to use a mismatched canvas/workspace or an unavailable capability.

Logs must not include access tokens, Skill file contents, prompts, generated binary content, or provider secrets. Authorization and sandbox uncertainty always fail closed. Stable internal error codes include `canvas_context_required`, `canvas_access_denied`, `capability_denied`, `skill_catalog_invalid`, `sandbox_unavailable`, `sandbox_policy_rejected`, `sandbox_timeout`, `sandbox_resource_limit`, `sandbox_cleanup_pending`, and `artifact_rejected`.

## Testing and Verification

The implementation is complete when tests demonstrate:

- Skill management, marketplace, import, install, toggle, and uninstall UI and routes no longer exist.
- Dynamic Skill contracts, services, configuration, and runtime database reads are absent.
- External import flags/rate limits and the runtime `LOOMIC_SKILLS_ROOT` override are absent; the packaged manifest is the only production catalog location.
- The destructive migration removes the dynamic Skill schema and data.
- Only manifest-listed repository Skills exist in the Agent's read-only `/skills/` view; unlisted files, traversal, symlinks, duplicate identities, invalid frontmatter, and package budget violations fail validation.
- A Skill is absent from discovery and file access unless every declared prerequisite capability is granted; Skill metadata cannot expand the capability snapshot.
- `createDeepAgent` receives the official `skills` option and does not receive a second manually generated Skill prompt.
- Runs without a canvas or without canvas access are rejected.
- A tool cannot target a canvas or workspace different from the bound execution context.
- Application tools, DeepAgents framework tools, backend operations, and subagents cannot exceed the effective capability set; direct application-port calls and stale authorization are also denied.
- The effective tool-name snapshot is asserted for every policy fixture so framework upgrades cannot add an unclassified tool.
- Persisted runs record the bound resource identifiers, policy version, capability snapshot, and Skill catalog digest; resume can only reduce that authority.
- Failure to persist the execution context prevents acknowledgement and execution through both HTTP and WebSocket entry points.
- Production execute uses an isolated per-run lease with proven limits, Skill script upload, controlled artifact download, cleanup, and orphan reconciliation; no host backend fallback exists.
- The real-provider test reports the pinned Sandbox image digest and runs `canvas-design` without network package installation; verification records the image dependency/SBOM evidence.
- Production-like sandbox tests prove public internet, loopback, private/link-local ranges, cloud metadata endpoints, and DNS/redirect alternatives are unreachable.
- Command timeout, idle TTL, hard lease TTL, output, CPU, memory, PID, and disk limits each have an enforcement test against the real provider or provider-issued evidence that the test independently verifies.
- Agent and Sandbox Skill paths are both `/skills/<name>/...`; uploaded resources are digest-verified/read-only, and built-in Skill instructions contain no host path or path-injection dependency.
- The `canvas-design` Skill completes a PNG/PDF workflow through the selected real Sandbox provider, while malformed, oversized, SVG, executable, archive, and symlink artifacts are rejected.
- One user with two open canvases cannot route screenshot or mutation RPCs to the other canvas.
- Authorized built-in Skills and canvas operations continue to work.
- Logs contain correlation identifiers and decisions without sensitive content.
- Restart recovery finds and destroys orphan sandbox leases from durable lease records.

Verification includes focused unit/integration tests, workspace boundary checks, TypeScript checks, and the relevant browser smoke test after the Skills navigation and page are removed.

## Out of Scope

- External or community Skill support of any kind.
- Skill approval, signatures, revisions, installation, workspace toggles, or custom-data preservation/import/export tooling.
- A user-facing built-in Skill catalog.
- Restoring deleted custom Skill data.
- Broad redesign of the Agent, canvas, generation providers, or sandbox provider beyond the authorization boundary required here.

## Governance Alignment

Phase 3 now resolves the two original governance issues through separate controls:

- `ENG-027` remains a production isolation problem and is resolved only by the isolated sandbox acceptance criteria.
- `ENG-030` is resolved by removing every external/user Skill ingestion and execution path and proving that only manifest-listed repository Skills can load. No supply-chain approval subsystem is built.

Phase 3 verification must update the platform governance design, governance roadmap, engineering issue register, earlier phase forward references, repository documentation, and CODEMAP so they describe this final product boundary.
