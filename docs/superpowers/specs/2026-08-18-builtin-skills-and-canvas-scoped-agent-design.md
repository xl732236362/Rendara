# Built-in Skills and Canvas-scoped Agent Design

**Status:** Approved
**Date:** 2026-08-18
**Goal:** Reduce the current governance surface by removing user-extensible Skills and restricting every Agent run to its current canvas and explicitly authorized server capabilities.

## Decision

Loomic will not support user-created, imported, downloaded, installed, or workspace-configurable Skills. Skills are internal product assets stored in the repository, reviewed with application code, and released with the server. Existing custom Skill data is deleted without migration or recovery support.

This decision supersedes the external Skill revision, review, approval, installation, and compatibility-projection work described in `2026-08-18-phase-3-agent-skill-security-design.md`. That document's deny-by-default execution and capability-enforcement principles remain applicable.

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

The repository `skills/` directory is the only Skill source. A server-owned loader scans an explicit manifest or allowlisted directories during application startup. It validates each package before it can enter the runtime:

- Directory name and manifest identity must match.
- `SKILL.md` and all referenced files must remain inside the configured Skills root after path resolution.
- Duplicate names, invalid paths, unreadable files, and malformed metadata fail startup outside test/development fixtures.
- The loaded catalog is immutable for the lifetime of the process.

The composition root constructs the catalog once and injects it into the Agent factory. A run cannot add, replace, disable, or select Skills. The runtime exposes built-in Skill files through a read-only virtual namespace and logs the catalog identity and Skill names attached to each run. The catalog must never be populated from workspace or user data.

Internal developers add or update a Skill through a normal code change. Code review, automated validation, repository history, and deployment rollback provide the governance lifecycle.

## Agent Authorization Boundary

Every Agent run is canvas-scoped. An accepted run must contain a non-empty `canvasId`; session- or conversation-only execution is rejected. Before the run is created, the HTTP or WebSocket boundary verifies that the authenticated user can access that canvas. The runtime then carries an immutable `AgentExecutionContext` containing:

```ts
interface AgentExecutionContext {
  runId: string;
  userId: string;
  workspaceId: string;
  canvasId: string;
  capabilities: readonly AgentCapability[];
}
```

The server derives this context from authenticated resources and deployment policy. Client input can request an operation but cannot grant a capability or override any context identifier.

Tools are registered from a server-owned allowlist. A tool is absent when its capability is not granted. High-risk application ports also call the shared authorization guard before side effects, so direct invocation cannot bypass the tool layer. Tools that affect canvas or project state receive the bound execution context; they do not accept a caller-selected canvas or workspace identifier.

Initial capability identifiers are deliberately narrow:

- `canvas.read`
- `canvas.mutate`
- `asset.persist`
- `image.generate`
- `video.generate`
- `brand_kit.read`
- `project.search`
- `sandbox.execute`, only when the configured sandbox policy permits it

Capability resolution fails closed. Missing context, failed ownership resolution, unknown capability names, and inconsistent canvas/workspace relationships reject the run or tool call before side effects.

## Data Removal

A forward-only migration deletes existing custom and system Skill installation data, then drops the dynamic Skill schema in dependency order. The migration includes explicit logging/verification queries suitable for deployment evidence. No archive table, compatibility view, or restore path is created.

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

Logs must not include access tokens, Skill file contents, prompts, generated binary content, or provider secrets. Authorization uncertainty always fails closed with stable internal error codes such as `canvas_context_required`, `canvas_access_denied`, and `capability_denied`.

## Testing and Verification

The implementation is complete when tests demonstrate:

- Skill management, marketplace, import, install, toggle, and uninstall UI and routes no longer exist.
- Dynamic Skill contracts, services, configuration, and runtime database reads are absent.
- The destructive migration removes the dynamic Skill schema and data.
- Only allowlisted repository Skills load, traversal and duplicate identities fail, and the catalog is immutable after startup.
- Runs without a canvas or without canvas access are rejected.
- A tool cannot target a canvas or workspace different from the bound execution context.
- Unauthorized tools are not registered, and direct application-port calls are also denied.
- Authorized built-in Skills and canvas operations continue to work.
- Logs contain correlation identifiers and decisions without sensitive content.

Verification includes focused unit/integration tests, workspace boundary checks, TypeScript checks, and the relevant browser smoke test after the Skills navigation and page are removed.

## Out of Scope

- External or community Skill support of any kind.
- Skill approval, signatures, revisions, installation, workspace toggles, or migration tooling.
- A user-facing built-in Skill catalog.
- Restoring deleted custom Skill data.
- Broad redesign of the Agent, canvas, generation providers, or sandbox provider beyond the authorization boundary required here.
