# Phase 3 Tool-only Agent Verification

Date: 2026-08-19

## Scope

Phase 3 permanently removes user-defined Skills and arbitrary Agent execution.
The runtime now composes an exact server-owned LangChain tool allowlist from a
persisted canvas-scoped capability context. Built-in Skills are limited to the
closed manifest and can only be read through the bounded Skill tool.

## Automated evidence

The final verification commands are run from the repository root:

| Check | Result |
| --- | --- |
| `pnpm lint` | Pass; no errors |
| `pnpm typecheck` | Pass; 8 Turbo tasks successful |
| `pnpm test` | Pass; server 319 passed and 7 database tests skipped, web 94 passed, workspace 87 passed |
| `pnpm build` | Pass; 5 Turbo tasks successful |
| `git diff --check` | Pass |

The architecture tests additionally assert that:

- Agent tools contain no `execute`, shell, process, generic filesystem, or
  implicit DeepAgents authority.
- Tool construction fails when a persisted authorized capability has no
  matching server tool.
- Canvas state is obtained through `inspect_canvas`; it is not injected into
  the prompt by direct repository access.
- Generated media is inserted only when both the persisted run context and the
  current deployment policy grant `canvas.mutate`.
- Canvas mutations, Agent effects, job receipts, and outbox events commit
  atomically behind attempt, fencing-token, resource, and current workspace
  membership checks. Replays return the bounded recorded effect result without
  persisting full Canvas content in the effect table.
- The video subagent receives the same guarded and fenced `generate_video`
  tool instance as the parent authority.
- Dynamic Skill routes, UI, contracts, tables, and discovery paths are absent.
- The only built-in Skill is the manifest-listed `json-image-prompt`; the
  retired `canvas-design` package is excluded.

## Browser smoke evidence

The local web and API applications were started and checked through the browser:

- `/skills` renders the normal 404 page.
- `/api/health` returns HTTP 200.
- `/api/skills` and `/api/skills/import` return HTTP 404.

The browser session had no authenticated user and `/home` redirected to
`/login`, so authenticated inspect, mutate, generation, and two-canvas routing
were not repeated manually. Their authority, ownership, and cross-canvas
rejection paths are covered by the automated server boundary and authorization
tests.

## Database verification gap

`supabase db reset --local` and `supabase test db --local` could not run in this
environment because the Supabase CLI is not installed. Seven integration tests
are therefore reported as skipped by the server suite. The migration and pgTAP
coverage are present, but must run in an environment with the local Supabase
toolchain before production deployment.

## Residual risk

Attempt recovery validates the stored catalog digest, creates a fresh attempt,
and intersects persisted Skills and capabilities with the current policy.
Current HTTP and WebSocket starts, cancellation, lease fencing, atomic effect
deduplication, membership revocation, and stale-attempt rejection are covered.

ENG-027 and ENG-030 are closed for the Phase 3 application boundary. The local
database execution gap above remains a release-environment verification item,
not an alternate runtime authority.
