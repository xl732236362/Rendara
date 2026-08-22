# Server Architecture

### `apps/server/src/app.ts`

Composition root for Fastify, validated environment loading, infrastructure clients, services, security boundaries, routes, sealed registries, and frozen application-use-case dependencies. Phase 5 composes durable realtime; Phase 6A additionally requires and composes the active/previous pagination cursor key ring before route registration.

### `apps/server/src/events/`

Transactional outbox publishing and the Phase 5 realtime projection. Canvas events are appended to PostgreSQL before local fan-out, replicas treat LISTEN/NOTIFY as a wake-up hint and reread durable records, and bounded reconciliation recovers missed notifications. Generation and Agent terminal user events retain outbox retry semantics.

### `apps/server/src/http/`

REST interface adapters authenticate, parse shared boundary schemas, call application use cases/services, and serialize responses. Phase 6A adds cursor-paginated V2 routes for projects, brand kits, credit transactions, chat sessions and chat messages while retaining five legacy list routes for a measured removal window. A structured route inventory rejects new unbounded collection services.

### `apps/server/src/ws/`

WebSocket commands, connection identity, local fan-out, bounded test/optimization buffering, and logging. Durable `canvas.resume` authorizes before replay and returns replay/caught-up/cursor-gap metadata. Active run reporting queries persisted Agent attempt state; `activeRuns` is only a local correlation cache. Pending browser RPC remains replica-local and retryable.

### `apps/server/src/agent/`

Tool-only LangChain/LangGraph runtime, persistence, prompts, and exact capability-mapped tools. Accepted runs persist canonical canvas scope, built-in Skill catalog identity, attempt leases, fencing tokens, and effect receipts. There is no Agent shell, Sandbox, generic filesystem, or automatic framework tool authority.

### `apps/server/src/features/`

Domain-oriented services and adapters for jobs, credits, canvas, chat, projects, payments, settings, uploads, and Agent execution metadata. Projects, brand kits, credits and chat expose stable keyset pages; chat messages use canonical durable content blocks and server-owned terminal persistence.

### `apps/server/src/pagination/`

Signed opaque cursor codec and keyset helpers. Tokens bind user/workspace/resource/filter/direction scope, enforce expiry, redact diagnostics, and support active plus previous keys for rotation without exposing cursor material.

### `apps/server/src/generation/`

Image/video provider interfaces and implementations. Provider selection uses an instance-based sealed registry that rejects duplicate provider/model identifiers and exposes immutable catalogs and frozen execution facades.

### `apps/server/src/worker.ts`

PGMQ polling process. It receives an explicit sealed executor/provider catalog, validates versioned queue envelopes against authoritative jobs, renews visibility, executes generation, and acknowledges/retries messages.

### `apps/server/src/security/`

Phase 0 boundaries: resource authorization, safe external fetches, HTTP rate limiting, and WebSocket command budgets. Keep these fail-closed while application boundaries move.
