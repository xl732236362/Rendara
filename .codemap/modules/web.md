# Web Application

### `apps/web/src/app/`

Next.js App Router pages for public landing/auth/pricing and authenticated workspace pages. Workspace layout supplies navigation and shared providers.

### `apps/web/src/components/`

Product UI for canvas, chat, projects, skills, brand kits, credits, and settings. Canvas and chat components are large integration points; broad component splitting belongs to phase 6, not phase 1.

### `apps/web/src/hooks/`

Client lifecycle and interaction orchestration. Phase 6A moves projects, brand kits, credit history, chat history and model catalogs behind owner-scoped TanStack Query hooks; `use-chat-sessions.ts` merges durable message pages with the live run overlay and owns exact-query recovery after invalid cursors.

### `apps/web/src/lib/query/`

Single server-state ownership boundary. `keys.ts` creates identity-scoped, normalized keys; `query-client.ts` centrally retries only transient reads and disables mutation retry; `workspace-queries.ts` owns V2 collection fetching, cancellation and cursor traversal. Architecture tests reject raw query-key arrays, identity-derived global keys and component-local V2 collection fetches.

### `apps/web/src/lib/api/`

Schema-aware Phase 6A page clients for projects, brand kits, credits and chat plus model/viewer reads. Cursors are opaque transport values and are never decoded or logged by the browser.

### `apps/web/src/lib/server-api.ts`

Primary domain REST helpers. Every helper delegates to schema-aware `apiFetch`, which validates success/error payloads, distinguishes caller abort from timeout, supports JSON/FormData/empty responses, and preserves the public helper signatures.

### `apps/web/src/lib/api-client.ts`

Shared HTTP transport boundary. It joins base paths safely, specializes canonical 401 errors, cleans abort listeners/timers, and rejects malformed or schema-invalid responses before data reaches UI code.

### `apps/web/src/lib/env.ts`

Browser-safe server URL configuration. Server-only secrets must never be imported into this package or exposed through public configuration.
