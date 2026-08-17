# Loomic - Codemap

> **Version**: 0.0.0 | **Stack**: TypeScript, Next.js, Fastify, LangGraph, Supabase | **Architecture**: pnpm monorepo
> **Created**: 2026-08-17 | **Updated**: 2026-08-18

## L1: Project Panorama

Loomic is an AI creative workspace. The browser owns interactive canvas and chat state; Fastify exposes REST and WebSocket adapters; LangGraph/DeepAgents orchestrates tools; PGMQ workers perform long-running generation; Supabase provides authentication, PostgreSQL, storage, and persistence.

```text
Next.js web -> schema-aware REST/WebSocket -> Fastify adapters -> application use cases
                                                               |-> services/agent runtime
                                                               |-> PGMQ -> worker -> model providers
                                                               `-> Supabase DB/Auth/Storage
```

| Area | Technology | Entry points |
| --- | --- | --- |
| Web | Next.js 15, React 19, Excalidraw | `apps/web/src/app/`, `apps/web/src/components/canvas-editor.tsx` |
| API | Fastify 5, WebSocket | `apps/server/src/server.ts`, `apps/server/src/app.ts` |
| Agent | LangGraph, LangChain, DeepAgents | `apps/server/src/agent/runtime.ts` |
| Worker | Node.js, PGMQ | `apps/server/src/worker.ts` |
| Data | Supabase/PostgreSQL | `supabase/migrations/` |
| Contracts | Zod, TypeScript | `packages/shared/src/` |
| Quality | Vitest, Playwright, Biome, Turbo | `package.json`, `.github/workflows/ci.yml` |

## L2: Domain Navigation

| Domain | Modules |
| --- | --- |
| [Server](modules/server.md) | API composition, agent runtime, feature services, generation, worker, security |
| [Web](modules/web.md) | routes, canvas/chat UI, hooks, API clients |
| [Packages](modules/packages.md) | shared contracts, config and UI packages |
| [Platform](modules/platform.md) | Supabase, CI, tests, deployment and skills |

## Dependency Direction

```text
apps/web -> packages/shared
apps/server -> packages/shared
apps/server interfaces -> application use cases -> feature adapters -> Supabase / PGMQ
agent runtime -> injected use cases / LangGraph tools
worker -> sealed executor registry -> generation providers / Supabase / storage
```

## Development Index

| Goal | Start here | Also inspect |
| --- | --- | --- |
| Add or change an HTTP contract | `packages/shared/src/http.ts` | route in `apps/server/src/http/`, client in `apps/web/src/lib/server-api.ts` |
| Change Agent execution | `apps/server/src/agent/runtime.ts` | `agent/deep-agent.ts`, `agent/tools/`, WS and run routes |
| Add a generation model | `apps/server/src/generation/providers/` | `packages/shared/src/credits.ts`, model routes and UI preferences |
| Change background jobs | `apps/server/src/features/jobs/` | `apps/server/src/worker.ts`, `packages/shared/src/job-contracts.ts` |
| Change canvas persistence | `apps/server/src/features/canvas/` | `canvas-editor.tsx`, Agent canvas tools, migrations |
| Change security boundaries | `apps/server/src/security/` | `app.ts`, HTTP/WS adapters, `supabase/tests/` |

## Change Log

| Date | Change | Scope |
| --- | --- | --- |
| 2026-08-17 | Initial codemap after phase 0 | Entire repository |
| 2026-08-18 | Phase 1 contracts, application boundaries, explicit registries, and architecture gates | Server, Web, packages, quality |
