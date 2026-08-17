# Platform, Data, And Quality

### `supabase/`

Ordered PostgreSQL migrations, local configuration, and database security tests. Phase 1 does not redesign the schema or job state machine; those are phase 2 responsibilities.

### `.github/workflows/ci.yml`

Quality, database reset/security, and Docker gates established in phase 0. Every phase 1 change must keep `pnpm ci:check`, Supabase tests, and the production container smoke test green.

### `tests/` and package tests

Workspace invariants use Node test; server/shared/web behavior uses Vitest; browser workflows use Playwright. Phase 1 adds contract, configuration, registry, application use-case, error-boundary, and API-client tests.

### `skills/`

Workspace skills loaded by the Agent. External import is gated and disabled by default after phase 0. Full trust/capability enforcement belongs to phase 3.

### Deployment Files

`apps/server/Dockerfile`, `railway.json`, and `vercel.json` define API/worker and static web deployment. Environment-template validation introduced in phase 1 covers these declared process requirements without embedding secrets.

