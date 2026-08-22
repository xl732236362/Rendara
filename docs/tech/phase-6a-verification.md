# Phase 6A data layer verification

## Verification context

- Time: 2026-08-22 16:24-18:15 +08:00
- Baseline HEAD: `96a4e5828de6`
- Runtime: Windows, Node `v24.14.0`, pnpm `10.26.2`, Supabase CLI `2.115.0`, Docker Engine `29.6.1`
- Local database: Supabase worktree stack on the checked-in ports; no persistent configuration changes
- Secret handling: commands used local credentials only through process environment. This document records no keys, secrets, or cursor values.

## Fresh gate evidence

| Command | Result | Exact evidence |
| --- | --- | --- |
| `pnpm ci:check` | exit 0 | lint 485 files, 0 errors and 506 historical warnings; typecheck 8/8 tasks; workspace 162/162; Config 34/34; Shared 69/69; Server 588 passed/10 skipped; Web 211/211; UI typecheck; build 5/5 packages and Web 14/14 static pages |
| `pnpm exec supabase db reset --yes` | exit 0 | 48 checked-in migration files and 48 `Applying migration` records through `20260823000001_phase6a_pagination.sql`; exact set difference is empty; no seed file configured |
| `pnpm exec supabase test db` | exit 0 | 8 pgTAP files, 212/212 tests |
| `pnpm exec supabase db lint --level warning` | exit 0 | extensions/langgraph/private/public schemas, 0 findings |
| `PHASE2_TEST_DATABASE_URL=<local> pnpm --filter @loomic/server test:integration` | exit 0 | 1 file, 7/7 real PostgreSQL concurrency/failpoint tests |
| `git diff --check` | exit 0 | no whitespace errors after the final documentation update |

| Workspace/package | Tests | Typecheck | Build |
| --- | --- | --- | --- |
| Workspace invariants | 162 passed | n/a | n/a |
| `@loomic/config` | 34 passed | exit 0 | exit 0 |
| `@loomic/shared` | 69 passed | exit 0 | exit 0 |
| `@loomic/ui` | test delegates to typecheck, exit 0 | exit 0 | exit 0 |
| `@loomic/server` | 588 passed, 10 skipped | exit 0 | exit 0 |
| `@loomic/web` | 211 passed | exit 0 | exit 0; 14/14 static pages |

Turbo reported 8/8 successful typecheck graph tasks (five package typechecks plus dependency builds) and 5/5 successful package build tasks.

The first integration diagnostic without `PHASE2_TEST_DATABASE_URL`, and a second diagnostic with the unrelated `SUPABASE_DB_URL`, each skipped 7/7 tests. They are not counted as passing evidence. A real run then exposed two obsolete six-versus-eight argument RPC calls; after aligning the integration test with the current six-argument migration contract, 7/7 executed and passed.

## Focused evidence

- Architecture TDD: the original gate first failed because `collectPhase6AArchitectureSources` was absent. First-review hardening added 13 bypass fixtures; that RED run passed 95 and failed 13. Second-review provenance, direct V2 request, SQL and unknown-GET fixtures produced a RED of 109 passed and 14 failed, followed by 125 passed and 3 failed for alias/owner/global forwarding. Third-review identity-taint, URL-evaluator and unified route-discovery fixtures produced 130 passed and 11 failed; indirect helper and aliased-auth-import propagation each produced a subsequent RED with one failure. Fourth-review destructuring, unresolved component URL, namespace-domain and Fastify-provenance fixtures produced 144 passed and 10 failed; a subsequent focused positive-provenance RED failed 0/1 on a local same-name `Fastify` factory. Fifth-review typed-plugin and nested-register contextual provenance produced 154 passed and 3 failed. Sixth-review lexical shadowing, mutation diagnostic continuity, and bounded-cap decoy fixtures produced 157 passed and 3 failed. Seventh-review import-declaration identity and actual-cap-flow fixtures produced 160 passed and 2 failed: both domain/Fastify same-name shadows inherited provenance, while both same-method cap decoys were incorrectly accepted. The final workspace run passed 162/162, including 73 Phase 6A checks and a full production-source scan.
- Cursor rotation and wiring: `src/pagination/cursor-codec.test.ts` plus `src/app.env.test.ts` passed 55/55. This covers active/previous-key decoding, expiry/scope rejection, startup validation, redacted cursor logging, and composition wiring.
- Legacy compatibility: five old list endpoints remain registered beside V2: projects, brand kits, credit transactions, chat sessions, and chat messages. Current Web collection owners use only the five cursor-paginated V2 endpoints.

## Collection route inventory

Inventory source: cursor=5, bounded=2, legacy-gap=9, total=16.

The fail-closed GET inventory contains 29 registered production routes: the 16 collection routes above plus 13 explicitly justified singleton routes. One shared discovery pass resolves literal/const Fastify `.get` paths and `.route` GET method/path objects for both the scanner and inventory audit. Receiver provenance follows `FastifyInstance` parameters, imported `Fastify()` factory declarations, typed `FastifyPluginAsync`/`FastifyPluginCallback` callbacks, nested `.register` callbacks, and lexical aliases instead of relying on names. Identifier resolution uses the nearest source/function/block/catch declaration, so shadows cannot borrow import, URL, taint, callee, factory, or receiver provenance from another scope. Bounded cap evidence uses explicit inventory contracts: jobs requires `.limit(50)` on the query declaration/assignment flow consumed by `await` or return, and attachments requires top-level `limit: 100` in argument zero of the exact repository call. Unknown, nested, dynamic, or unrelated same-method structures fail closed.

| Class | Routes | Bound |
| --- | --- | --- |
| Cursor-paginated | 5 V2 routes: projects, brand kits, credit transactions, chat sessions, chat messages | shared `limit` 1-100 plus signed scoped cursor |
| Bounded | jobs; generated-asset attachments | jobs `.limit(50)`; attachment adapter `limit: 100` plus response schema max |
| Legacy compatibility gap | 5 legacy routes matching the V2 resources | unbounded service reads retained temporarily |
| Uncapped catalog gap | fonts; agent/image/video models | finite at current runtime, but no locally enforced numeric cap or schema enum |

ENG-035 remains partially resolved because the five legacy compatibility routes and four catalog routes lack a locally proven cap. Removal window for legacy routes: instrument calls, deploy V2 owners, require 14 consecutive days with zero legacy list calls, then remove in the next deployment window; earliest target is Phase 6B. Roll back by restoring the compatibility route registrations and legacy response schemas from the pre-removal release while leaving V2 routes intact.

## Resource ownership inventory

| Resource | Query owner | Consumers/status |
| --- | --- | --- |
| viewer/workspace identity | `workspace-queries.ts` | shared by projects, brand kits, credits, chat, settings and model consumers |
| projects | `workspace-queries.ts` | Home and Projects share one owner-scoped key factory |
| brand-kit catalog | `workspace-queries.ts` | Brand Kit page; detail recovery remains page-owned |
| credit transactions | `workspace-queries.ts` | usage history |
| chat sessions/messages | `workspace-queries.ts` plus `use-chat-sessions.ts` controller | durable pages and live overlay have explicit ownership |
| image/video models | `workspace-queries.ts` | panels, chat and preferences |
| agent models | `workspace-queries.ts` | selector and Settings query path |

ENG-038 remains partially resolved. Task 9 Minor gaps prevent a single-owner closure: old-run listener ownership cleanup is still coupled to the chat controller lifecycle, and `agent-section.tsx` retains a component-local model-catalog failure/retry path. Neither affects ENG-035, but both block ENG-038 closure.

## Known warnings and rollback

- Biome reports 506 historical warnings but 0 errors; this phase does not broaden warning cleanup.
- Next.js warns about multiple lockfiles/workspace-root inference and missing `metadataBase` during build.
- Supabase reset warns that `supabase/seed.sql` is absent.
- Docker Desktop was installed but stopped. It was started without changing ports; a root-worktree Supabase stack occupying the checked-in ports was stopped with volume backup before starting this worktree stack.
- Query rollback: remove the workspace `QueryProvider`/V2 consumers and restore legacy consumers only for an emergency release; do not remove V2 server routes or cursor keys during rollback.
- Cursor-key rollback: retain the outgoing key as `PAGINATION_CURSOR_PREVIOUS_KEY`/ID for at least the maximum cursor TTL; never log token material.
- Chat rollback: keep durable server messages authoritative and disable only the paged client adapter; do not restore assistant double persistence.

Task 10 does not declare Phase 6A complete. Independent dual review and the final aggregate review remain required.
