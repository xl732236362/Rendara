# Platform, Data, And Quality

### `supabase/`

Ordered PostgreSQL migrations, local configuration, and database security tests. Phase 5 adds durable realtime and strict attachment finalization. Phase 6A adds pagination-supporting indexes and pgTAP coverage for stable keyset ordering while keeping cursor signing keys in process environment rather than the database.

### `.github/workflows/ci.yml`

Quality, database reset/security, and Docker gates established in phase 0. Every phase 1 change must keep `pnpm ci:check`, Supabase tests, and the production container smoke test green.

### `tests/` and package tests

Workspace invariants use Node test; server/shared/web behavior uses Vitest; browser workflows use Playwright. TypeScript-AST architecture enforcement resolves identifiers from their nearest source/function/block/catch declaration, propagates identity taint through nested bindings, preserves authoritative import provenance under shadowing, evaluates composed V2 URLs, and emits fail-closed mutation diagnostics without aborting later scans. Unified Fastify route discovery feeds both scanner and inventory audit. Structured bounded contracts tie caps to the declared owner export and method rather than file-wide literals. The GET inventory remains 29 production routes (13 singleton plus 16 collection), with uncapped catalogs and compatibility routes explicit gaps. Verification evidence and removal/rollback windows live in `docs/tech/phase-6a-verification.md`.

### `skills/`

Server-owned built-in Skills. Only `builtin-skills.manifest.json` entries are loaded; users cannot create, import, install, enable, or download Skills. `json-image-prompt` is currently the only listed Skill.

### Deployment Files

`apps/server/Dockerfile`, `railway.json`, `deploy/railway-api.json`, `deploy/railway-worker.json`, and `vercel.json` define API/worker and Web deployment. Environment-template validation covers process requirements and exact runtime entrypoints without embedding secrets. The API requires `SUPABASE_DB_URL` plus active cursor key ID/key, accepts a previous key pair during rotation, and Railway gates traffic on `/api/health/realtime`.
