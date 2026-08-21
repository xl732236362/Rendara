# Platform, Data, And Quality

### `supabase/`

Ordered PostgreSQL migrations, local configuration, and database security tests. Phase 3 adds durable Agent attempts/effects/Skill read budgets and permanently drops the former dynamic Skill schema. Phase 5 adds service-role realtime canvas events, never-reset per-canvas cursors, replay/gap RPCs, transaction-commit notifications, bounded retention cleanup, and a forward fix that passes server-resolved attachment geometry to the strict finalizer.

### `.github/workflows/ci.yml`

Quality, database reset/security, and Docker gates established in phase 0. Every phase 1 change must keep `pnpm ci:check`, Supabase tests, and the production container smoke test green.

### `tests/` and package tests

Workspace invariants use Node test; server/shared/web behavior uses Vitest; browser workflows use Playwright. Phase 1 coverage includes contracts, configuration, registries, application use cases, error boundaries, API-client behavior, and TypeScript-AST architecture enforcement with actionable file/line diagnostics.

### `skills/`

Server-owned built-in Skills. Only `builtin-skills.manifest.json` entries are loaded; users cannot create, import, install, enable, or download Skills. `json-image-prompt` is currently the only listed Skill.

### Deployment Files

`apps/server/Dockerfile`, `railway.json`, `deploy/railway-api.json`, `deploy/railway-worker.json`, and `vercel.json` define API/worker and Web deployment. Environment-template validation covers process requirements and exact runtime entrypoints without embedding secrets. The API requires `SUPABASE_DB_URL` and Railway gates traffic on `/api/health/realtime`.
