# Phase 3 Amendment: Built-in Skills and Canvas-scoped Agent

**Status:** Approved; authoritative Phase 3 design
**Date:** 2026-08-18
**Goal:** Remove user-extensible Skills and arbitrary code execution, then restrict every Agent run to its current canvas and an explicit server-owned tool allowlist.

## Decision

Loomic does not support user-created, imported, downloaded, installed, or workspace-configurable Skills. Skills are internal repository assets reviewed and released with application code. Existing custom Skill data is deleted without preservation, export, conversion, or recovery support.

Loomic Agent never receives `execute`, Shell, Python, arbitrary process execution, package installation, or a generic network-fetch tool. This applies to development, test, and production Agent construction. There is no local-execute feature flag and Phase 3 does not build a Sandbox. If arbitrary execution is proposed later, it requires a new security design and cannot be enabled by configuration alone.

Every node and canvas capability, including reads, is exercised through an explicit authorized tool call. The Agent cannot access canvas/node repositories, Supabase, Excalidraw state, browser internals, canvas services, or mutation services directly. Canvas data is not injected into the system prompt or run context as an alternate read path; only bounded tool results may enter model context.

This document is the only authoritative Phase 3 design under the platform governance plan. It supersedes the earlier Skill supply-chain and Sandbox implementation plans; those obsolete files are removed and Git history is the decision record.

## Scope

Phase 3 removes:

- Skill creation, editing, deletion, URL import, marketplace search/install, workspace installation, enable/disable, and uninstall UI.
- The corresponding HTTP routes, application ports, adapters, rate limits, configuration, contracts, dependencies, and tests.
- Dynamic Skill database tables, policies, triggers, functions, files, installations, and stored data.
- Runtime Skill loading from Supabase, requests, user storage, environment-selected roots, or external sources.
- `LocalShellBackend`, `SandboxBackendProtocol` adapters, `allowLocalAgentExecute`, `execute`, sandbox-file persistence, and every Agent-reachable process-spawn path.
- Direct Agent access to canvas/node storage or application services outside registered tools.

Phase 3 retains only fixed tool-mediated capabilities for the current canvas: canvas/node inspection and mutation, image/video generation, brand-kit reading, canvas-scoped project search, asset persistence, and explicitly approved delegation. Each retained capability remains optional and server-authorized.

## Built-in Skill Catalog

The repository `skills/` directory is the only authoring source. A versioned `skills/builtin-skills.manifest.json` is the only loading authority. Its closed root schema contains `schemaVersion: 1` and `skills`; each entry contains only `name`, repository-relative `path`, and `requiredCapabilities`. Unknown fields, schema versions, paths, or capabilities fail startup.

At startup, `BuiltinSkillCatalog` reads only manifest entries and copies their bytes into an immutable in-memory catalog. It rejects:

- names outside `^[a-z0-9]+(?:-[a-z0-9]+)*$` or longer than 64 characters;
- missing/invalid `SKILL.md` frontmatter or descriptions over 1,024 characters;
- manifest/frontmatter identity mismatches and duplicate names or paths;
- traversal, symbolic links/reparse points, unreadable files, and paths outside the listed Skill directory;
- more than 32 Skills or 64 MB total, more than 256 files or 10 MB per Skill, `SKILL.md` over 256 KB, or supporting files over 10 MB.

The catalog digest is SHA-256 over the RFC 8785 canonical manifest followed by each included file in lexicographic relative-path order as `path + NUL + byteLength + NUL + SHA256(fileBytes)`. The catalog and digest are immutable for the process lifetime.

Each Skill declares prerequisites but cannot grant them. After capability resolution, the server exposes Skill summaries and content only when the run has `skill.read` and the Skill's `requiredCapabilities` are a subset of the run snapshot. Client input cannot select, enable, replace, or upload a Skill.

The first manifest contains `json-image-prompt`, requiring `image.generate`. The current `canvas-design` package is excluded because it requires `execute`, Python, Pillow, and reportlab. It may return only after being redesigned to use fixed authorized Loomic tools with no process execution.

Skill discovery uses catalog-provided name/description summaries. Full instructions and supporting text are available only through a server-owned read-only `read_builtin_skill` tool whose schema restricts `skillName` to the effective set and whose normalized relative path remains within that Skill. The tool accepts an optional opaque server-issued cursor bound to the run, Skill, path, and text position; returns at most 32 KiB of UTF-8 text per call; permits at most 16 distinct reads and 256 KiB total returned text per run; and returns `nextCursor` only when more authorized text remains. A durable atomic budget keyed by `runId` is shared by the main Agent, every subagent, and every resume/retry attempt. Each logical read is identified by `runId + skillName + normalizedPath + cursor-or-start`; its call and byte charge are reserved transactionally before content is returned, so concurrent calls cannot overspend. Retrying the same logical read is idempotent and does not consume the budget twice. Invalid, forged, or cross-run cursors fail closed; exceeding either run budget returns `skill_read_budget_exceeded`. Binary resources are not returned to the model. Loomic does not expose a generic host filesystem backend to load Skills.

## Agent Execution Context

Every accepted Agent run requires an explicit non-empty `canvasId`. Session- or conversation-only execution is rejected; adapters cannot infer a canvas from `conversationId`. Authorization resolves the canonical project/workspace from the canvas and verifies the supplied session/thread belongs to the same scope.

```ts
interface AgentExecutionContext {
  runId: string;
  userId: string;
  workspaceId: string;
  projectId: string;
  canvasId: string;
  capabilities: readonly AgentCapability[];
  capabilityPolicyVersion: string;
  skillCatalogDigest: string;
  effectiveSkillNames: readonly string[];
}
```

`AcceptAgentRun` authenticates, resolves the canonical project and workspace from the canvas, computes policy, filters Skills, persists the context, and only then publishes the run and acknowledges HTTP/WebSocket callers. Persistence failure creates no executable run. Every project-scoped tool and side effect uses the persisted `projectId` and re-resolves the canvas relationship before access; a moved or inconsistent canvas fails closed rather than silently adopting another project or workspace.

Resume/retry first requires the stored `skillCatalogDigest` to equal the active process catalog digest. A mismatch returns `skill_catalog_changed`; the caller may submit a new run through `AcceptAgentRun`, but the existing run cannot silently adopt new Skill summaries, instructions, or files. After the digest check, resume/retry intersects the stored capability snapshot with current deployment policy and current resource authorization: authority can shrink but never grow implicitly. It computes the current `capabilityPolicyVersion` from the complete canonical policy, then derives `effectiveSkillNames`, the exact main-Agent tool set, and every subagent definition/tool set from the reduced capability set. The complete derived state is persisted atomically as a new execution attempt before a fresh Agent instance is constructed; persistence or construction failure produces no model or tool execution, and an Agent instance from an earlier attempt is never reused.

The capability snapshot and Skill names are sorted, deduplicated, and frozen. `capabilityPolicyVersion` is the SHA-256 digest of the canonical deployment allowlist, provider declarations, resource rules, and complete tool/subagent mapping.

## Explicit Tool Boundary

The closed capability enum is:

- `skill.read`
- `canvas.read`
- `canvas.mutate`
- `asset.persist`
- `image.generate`
- `video.generate`
- `brand_kit.read`
- `project.search`
- `agent.delegate`

The minimum mapping is:

- `skill.read` gates `read_builtin_skill` and only the run's effective built-in Skills.
- `canvas.read` gates explicit node/canvas query, selection, inspection, and screenshot tools for the bound canvas; persisting a screenshot additionally requires `asset.persist`.
- `canvas.mutate` gates explicit node/canvas create, update, delete, group, reorder, and layout tools that call the canonical canvas application port.
- `image.generate` and `video.generate` gate canonical job-submission tools and the narrow persistence of that job's validated provider output through the canonical asset port. This intrinsic persistence accepts only bytes produced by the bound generation job and does not grant `asset.persist`, arbitrary upload, caller-selected URL/path, or reuse by another tool. A generated asset may be returned without canvas mutation; inserting or updating a result node additionally requires `canvas.mutate`. Ownership and all resulting effects use the bound context, never tool-selected resource IDs.
- `brand_kit.read` resolves only the bound canvas project's brand kit.
- `project.search` searches only the bound canvas namespace and accepts no project/workspace/root parameter.
- `asset.persist` gates explicit persistence of non-generation artifacts, such as an authorized canvas screenshot, through the canonical asset application port for the bound canvas/project/workspace. Generation jobs use only their narrower capability-specific persistence described above.
- `agent.delegate` gates `task`; subagents receive the same context and a subset of parent capabilities.

Every node/canvas operation is a tool call. Tool input may contain node IDs and operation payloads but never `canvasId`, `projectId`, `workspaceId`, database filters, or storage paths. The tool adapter supplies the bound context, validates node ownership/kind and operation schema, calls the application port, and returns a bounded result. Generated media enters the canvas only through the same canonical operation boundary.

HTTP/WS input, prompts, model output, Skill content, and subagents are never capability authorities. High-risk application ports revalidate current resource access and capability before every side effect. Canvas browser RPCs carry both `userId` and bound `canvasId` and route only to a currently authorized connection bound to that canvas.

The composition root constructs the final tool array from the allowlist. Tests assert its exact tool-name snapshot. DeepAgents/LangChain framework tools are not implicitly trusted: `execute`, generic fetch, filesystem read/write/edit, and any other unclassified auto-injected tool must be absent. Read-only framework state tools such as TODO management may remain only when explicitly recorded in the mapping as having no external resource access. If `createDeepAgent` cannot produce the exact allowed set, Phase 3 must compose the Agent from lower-level LangChain middleware rather than expose extra tools and rely on runtime errors.

## Data Removal and Deployment

A forward-only migration drops the dynamic Skill schema in dependency order and deletes all associated data. There is no archive, compatibility view, or restore path. This is an approved exception to the governance plan's normal independent-rollback principle because the feature is permanently removed before production launch.

Deployment has two forward-only releases:

1. Release A ships the built-in catalog and explicit tool boundary, removes dynamic Skill routes, removes every `execute` path, and leaves now-unused Skill tables in place.
2. After architecture checks and telemetry prove there are no dynamic Skill reads/writes, direct canvas/node access, or process-execution paths, Release B drops the schema.

Historical migrations remain unchanged so fresh databases reach the same final schema. Failures after Release B use forward fixes, not feature restoration.

## User Experience

The Skills navigation item and workspace page are removed without replacement. Built-in Skills are internal behavior, not user-configurable features. Removed endpoints return the normal route-not-found response.

## Logging and Failure Behavior

Structured logs record catalog identity, run/resource identifiers, effective capabilities/Skills, tool decisions, bound canvas, affected node IDs/counts, result status, and sanitized error code. They never record access tokens, prompts, Skill contents, full canvas content, binary content, or provider secrets.

Uncertainty fails closed. Stable errors include `canvas_context_required`, `canvas_access_denied`, `node_access_denied`, `capability_denied`, `skill_catalog_invalid`, `skill_catalog_changed`, `skill_read_budget_exceeded`, and `tool_not_authorized`.

## Completion Evidence

Phase 3 is complete only when evidence proves:

- Dynamic Skill UI, API, contracts, services, flags, rate limits, dependencies, database reads/writes, and schema are absent.
- `LOOMIC_SKILLS_ROOT`, `allowExternalSkillImport`, `allowLocalAgentExecute`, and equivalent bypass configuration are absent.
- Only manifest-listed, capability-compatible Skills can be discovered or read; unlisted files, invalid packages, traversal, forged/cross-run cursors, and Skill read-budget overflow fail.
- `json-image-prompt` works through `image.generate`; `canvas-design` is not loaded and no loaded Skill references `execute`, Shell, Python, or package installation.
- Run creation requires and persists canonical user/workspace/project/canvas scope before acknowledgement; stale, moved, inconsistent, or cross-canvas access is denied.
- Resume rejects a changed Skill catalog, persists any capability reduction as a new attempt, and never executes against stale catalog or authority metadata.
- Resume/retry atomically rebuilds and records policy version, effective Skills, main-Agent tools, and every subagent tool set, then constructs a fresh Agent instance.
- The effective main-Agent and every subagent tool-name snapshot exactly matches policy.
- Main Agent, concurrent subagents, and all attempts share one atomic per-run Skill read budget; retries are idempotent and concurrency cannot exceed it.
- `execute`, process-spawn APIs, `LocalShellBackend`, Sandbox backends, generic network fetch, generic filesystem tools, and sandbox-file persistence are unreachable from Agent construction.
- Every node/canvas read or mutation is observed as an authorized tool call; architecture tests reject Agent imports or calls into repositories, Supabase, Excalidraw/browser internals, and canvas services outside tool adapters.
- Tool schemas reject caller-supplied canvas/project/workspace IDs and storage paths; cross-canvas node IDs fail before side effects.
- Direct application-port calls, framework middleware, backend operations, and delegation cannot bypass capability checks.
- One user with two canvases open cannot route screenshot, mutation, generation result, or events to the other canvas.
- Authorized canvas, generation, brand-kit, search, asset, and safe delegation workflows continue to work.
- Generation persistence accepts only the bound job's validated provider output; arbitrary asset persistence remains unavailable without `asset.persist`.
- Logs contain decisions and correlation identifiers without sensitive content.
- Focused tests, architecture rules, server/web tests, TypeScript checks, database reset/tests, and browser smoke tests pass.

## Out of Scope

- External/community/user Skill support or migration tooling.
- Skill approval, signatures, revisions, installation, toggles, or a user-facing built-in catalog.
- Arbitrary Agent code execution, Sandbox infrastructure, generic filesystem access, or network access.
- Restoring deleted custom Skill data.
- Rewriting `canvas-design` in this phase.

## Governance Alignment

- `ENG-027` is resolved by permanently removing Agent-reachable process execution rather than isolating it.
- `ENG-030` is resolved by removing every external/user Skill path and proving that only manifest-listed internal Skills can load.

Phase 3 verification updates the governance roadmap, engineering issue register, earlier phase forward references, README, CODEMAP, and operations documentation to this final boundary.
