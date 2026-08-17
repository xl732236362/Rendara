# Server Architecture

### `apps/server/src/app.ts`

Composition root for Fastify, environment loading, infrastructure clients, services, security boundaries, routes, WebSocket state, and provider registration. Phase 1 moves mutable registries and application use cases into explicit dependencies created here.

### `apps/server/src/http/`

REST interface adapters. They authenticate, parse boundary input, call services, and serialize responses. Many routes currently repeat Zod detection and error mapping; phase 1 replaces this with a shared `AppError` boundary and global error handler.

### `apps/server/src/ws/`

WebSocket commands, connection identity, event buffering, and logging. Commands use shared schemas and resource authorization, but Agent run orchestration still needs to converge on application use cases.

### `apps/server/src/agent/`

LangGraph/DeepAgents runtime, persistence, tools, prompts, and backends. `runtime.ts` currently contains generation submission and cancellation orchestration also present in HTTP routes.

### `apps/server/src/features/`

Domain-oriented services for jobs, credits, canvas, chat, projects, skills, payments, settings, uploads, and Agent run metadata. Services often bind directly to Supabase; phase 1 introduces application orchestration without attempting the phase 2 database consistency redesign.

### `apps/server/src/generation/`

Image/video provider interfaces and implementations. Provider selection uses module-global mutable maps; phase 1 replaces them with an explicit registry that rejects duplicate provider and model identifiers.

### `apps/server/src/worker.ts`

PGMQ polling process. It resolves job executors, renews visibility, executes generation, and acknowledges/retries messages. Executor registration currently relies on import side effects and module-global state.

### `apps/server/src/security/`

Phase 0 boundaries: resource authorization, safe external fetches, HTTP rate limiting, and WebSocket command budgets. Keep these fail-closed while application boundaries move.

