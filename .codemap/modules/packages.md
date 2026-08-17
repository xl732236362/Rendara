# Shared Packages

### `packages/shared/`

Current cross-process Zod schemas and TypeScript types for HTTP, WebSocket, events, jobs, skills, credits, canvas, and Supabase records. Despite its name, this package is the existing contract authority. Phase 1 strengthens it in place before a later physical rename to `packages/contracts` is justified.

### `packages/config/`

Placeholder package with no production configuration ownership. Phase 1 gives it reusable environment schema metadata and deployment-template validation without allowing browser code to import server secrets.

### `packages/ui/`

Placeholder package. Shared UI extraction is intentionally outside phase 1 because stable product component boundaries have not yet emerged.

### Dependency Notes

`apps/server` currently installs Zod 4 while `packages/shared` installs Zod 3. Phase 1 aligns the workspace on Zod 4 and replaces error-name duck typing with actual shared error types.

