# Server Architecture

### `apps/server/src/app.ts`

Composition root for Fastify, validated environment loading, infrastructure clients, services, security boundaries, routes, WebSocket state, sealed registries, and frozen application-use-case dependencies.

### `apps/server/src/http/`

REST interface adapters authenticate, parse shared boundary schemas, call application use cases/services, and serialize responses. A global `AppError` boundary owns canonical error envelopes; workspace architecture tests reject route-local Zod duck typing and migrated orchestration bypasses.

### `apps/server/src/ws/`

WebSocket commands, connection identity, event buffering, and logging. Commands use shared schemas and resource authorization. Run-scoped `agent.cancel` deliberately remains an Agent lifecycle operation, distinct from background-job cancellation.

### `apps/server/src/agent/`

LangGraph/DeepAgents runtime, persistence, tools, prompts, and backends. Queued generation and canvas mutation consume injected application use cases; streaming and run lifecycle remain runtime responsibilities.

### `apps/server/src/features/`

Domain-oriented services and adapters for jobs, credits, canvas, chat, projects, skills, payments, settings, uploads, and Agent run metadata. The `application/` layer composes narrow ports without introducing the phase 2 database consistency redesign.

### `apps/server/src/generation/`

Image/video provider interfaces and implementations. Provider selection uses an instance-based sealed registry that rejects duplicate provider/model identifiers and exposes immutable catalogs and frozen execution facades.

### `apps/server/src/worker.ts`

PGMQ polling process. It receives an explicit sealed executor/provider catalog, validates versioned queue envelopes against authoritative jobs, renews visibility, executes generation, and acknowledges/retries messages.

### `apps/server/src/security/`

Phase 0 boundaries: resource authorization, safe external fetches, HTTP rate limiting, and WebSocket command budgets. Keep these fail-closed while application boundaries move.
