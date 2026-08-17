# Web Application

### `apps/web/src/app/`

Next.js App Router pages for public landing/auth/pricing and authenticated workspace pages. Workspace layout supplies navigation and shared providers.

### `apps/web/src/components/`

Product UI for canvas, chat, projects, skills, brand kits, credits, and settings. Canvas and chat components are large integration points; broad component splitting belongs to phase 6, not phase 1.

### `apps/web/src/hooks/`

Client lifecycle and server-state orchestration. Hooks currently call domain API helpers and manage loading/error/cache behavior locally.

### `apps/web/src/lib/server-api.ts`

Primary REST client. It duplicates headers and error handling and casts JSON responses without runtime validation. Phase 1 introduces a schema-aware fetcher while preserving the public domain helper API.

### `apps/web/src/lib/env.ts`

Browser-safe server URL configuration. Server-only secrets must never be imported into this package or exposed through public configuration.

