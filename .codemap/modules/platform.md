# Platform, Data, And Quality

### `supabase/`

Ordered PostgreSQL migrations, local configuration, and database security tests. Phase 5 adds durable realtime and strict attachment finalization. Phase 6A adds pagination-supporting indexes and pgTAP coverage for stable keyset ordering while keeping cursor signing keys in process environment rather than the database.

### `.github/workflows/ci.yml`

Quality, database reset/security, and Docker gates established in phase 0. Every phase 1 change must keep `pnpm ci:check`, Supabase tests, and the production container smoke test green.

### `tests/` and package tests

Workspace invariants use Node test; server/shared/web behavior uses Vitest; browser workflows use Playwright. TypeScript-AST architecture enforcement resolves authoritative module/export provenance, propagates identity taint into global query-key closures, evaluates composed V2 URLs, and rejects component-owned direct requests. A unified route discovery pass feeds both the scanner and exported fail-closed GET inventory, which classifies all 29 production routes (13 singleton plus 16 collection). The collection subset proves registration and caps where present while keeping uncapped catalogs and compatibility routes explicit gaps. Verification evidence and removal/rollback windows live in `docs/tech/phase-6a-verification.md`.

### `skills/`

Server-owned built-in Skills. Only `builtin-skills.manifest.json` entries are loaded; users cannot create, import, install, enable, or download Skills. `json-image-prompt` is currently the only listed Skill.

### Deployment Files

`apps/server/Dockerfile`, `railway.json`, `deploy/railway-api.json`, `deploy/railway-worker.json`, and `vercel.json` define API/worker and Web deployment. Environment-template validation covers process requirements and exact runtime entrypoints without embedding secrets. The API requires `SUPABASE_DB_URL` plus active cursor key ID/key, accepts a previous key pair during rotation, and Railway gates traffic on `/api/health/realtime`.
