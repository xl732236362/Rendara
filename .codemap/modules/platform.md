# Platform, Data, And Quality

### `supabase/`

Ordered PostgreSQL migrations, local configuration, and database security tests. Phase 1 does not redesign the schema or job state machine; those are phase 2 responsibilities.

### `.github/workflows/ci.yml`

Quality, database reset/security, and Docker gates established in phase 0. Every phase 1 change must keep `pnpm ci:check`, Supabase tests, and the production container smoke test green.

### `tests/` and package tests

Workspace invariants use Node test; server/shared/web behavior uses Vitest; browser workflows use Playwright. Phase 1 coverage includes contracts, configuration, registries, application use cases, error boundaries, API-client behavior, and TypeScript-AST architecture enforcement with actionable file/line diagnostics.

### `skills/`

Workspace skills loaded by the Agent. External import is gated and disabled by default after phase 0. Full trust/capability enforcement belongs to phase 3.

### Deployment Files

`apps/server/Dockerfile`, `railway.json`, `deploy/railway-api.json`, `deploy/railway-worker.json`, and `vercel.json` define API/worker and Web deployment. Environment-template validation covers process requirements and exact runtime entrypoints without embedding secrets.
