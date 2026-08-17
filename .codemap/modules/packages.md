# Shared Packages

### `packages/shared/`

Cross-process Zod 4 schemas and TypeScript types for HTTP, WebSocket, events, versioned queue envelopes, jobs, skills, credits, canvas, errors, and Supabase records. Despite its name, this package is the contract authority; a later physical rename to `packages/contracts` is optional rather than required for correctness.

### `packages/config/`

Owns reusable environment descriptors and Zod 4 parsing for API/Worker process requirements. Its server-only export is guarded from browser imports, and deployment/template validation consumes descriptors without resolving secret values.

### `packages/ui/`

Placeholder package. Shared UI extraction is intentionally outside phase 1 because stable product component boundaries have not yet emerged.

### Dependency Notes

All Loomic source packages importing Zod declare the central Zod 4 catalog dependency and resolve `4.3.6`. Workspace tests discover actual source imports and reject Zod 3 declarations. The Web `shadcn` build-tool graph still carries a transitive Zod 3 copy in the lockfile; its Tailwind CSS is used by the Web build, but its Zod copy does not cross into Loomic package/runtime contracts.
