# Phase 6A data layer verification

## Verification context

- Time: 2026-08-22 16:24-16:36 +08:00
- Baseline HEAD: `96a4e5828de6`
- Runtime: Windows, Node `v24.14.0`, pnpm `10.26.2`, Supabase CLI `2.115.0`, Docker Engine `29.6.1`
- Local database: Supabase worktree stack on the checked-in ports; no persistent configuration changes
- Secret handling: commands used local credentials only through process environment. This document records no keys, secrets, or cursor values.

## Fresh gate evidence

| Command | Result | Exact evidence |
| --- | --- | --- |
| `pnpm ci:check` | exit 0 | lint 485 files, 0 errors and 506 historical warnings; typecheck 5/5 tasks; workspace 95/95; Config 34/34; Shared 69/69; Server 588 passed/10 skipped; Web 211/211; UI typecheck; build 5/5 packages and Web 14/14 static pages |
| `pnpm exec supabase db reset --yes` | exit 0 | database recreated and 45 migrations applied through `20260823000001_phase6a_pagination.sql`; no seed file configured |
| `pnpm exec supabase test db` | exit 0 | 8 pgTAP files, 212/212 tests |
| `pnpm exec supabase db lint --level warning` | exit 0 | extensions/langgraph/private/public schemas, 0 findings |
| `PHASE2_TEST_DATABASE_URL=<local> pnpm --filter @loomic/server test:integration` | exit 0 | 1 file, 7/7 real PostgreSQL concurrency/failpoint tests |
| `git diff --check` | exit 0 | no whitespace errors after the final documentation update |

| Workspace/package | Tests | Typecheck | Build |
| --- | --- | --- | --- |
| Workspace invariants | 95 passed | n/a | n/a |
| `@loomic/config` | 34 passed | exit 0 | exit 0 |
| `@loomic/shared` | 69 passed | exit 0 | exit 0 |
| `@loomic/ui` | test delegates to typecheck, exit 0 | exit 0 | exit 0 |
| `@loomic/server` | 588 passed, 10 skipped | exit 0 | exit 0 |
| `@loomic/web` | 211 passed | exit 0 | exit 0; 14/14 static pages |

Turbo reported 8/8 successful typecheck graph tasks (five package typechecks plus dependency builds) and 5/5 successful package build tasks.

The first integration diagnostic without `PHASE2_TEST_DATABASE_URL`, and a second diagnostic with the unrelated `SUPABASE_DB_URL`, each skipped 7/7 tests. They are not counted as passing evidence. A real run then exposed two obsolete six-versus-eight argument RPC calls; after aligning the integration test with the current six-argument migration contract, 7/7 executed and passed.

## Focused evidence

- Architecture TDD: the new gate first failed because `collectPhase6AArchitectureSources` was absent. After implementing AST rules, workspace tests passed 95/95, including five negative fixtures and a full production-source scan.
- Cursor rotation and wiring: `src/pagination/cursor-codec.test.ts` plus `src/app.env.test.ts` passed 55/55. This covers active/previous-key decoding, expiry/scope rejection, startup validation, redacted cursor logging, and composition wiring.
- Legacy compatibility: five old list endpoints remain registered beside V2: projects, brand kits, credit transactions, chat sessions, and chat messages. Current Web collection owners use only the five cursor-paginated V2 endpoints.

## Collection route inventory

| Class | Routes | Bound |
| --- | --- | --- |
| Cursor-paginated | 5 V2 routes: projects, brand kits, credit transactions, chat sessions, chat messages | shared `limit` 1-100 plus signed scoped cursor |
| Intrinsically bounded | jobs; generated-asset attachments; agent/image/video model catalogs | jobs 50; outstanding attachments 100 plus schema max; catalogs are sealed/static provider sets |
| Upstream finite catalog | fonts | Google Fonts catalog cached for 24 hours; not database-growth-derived, but has no local response cap |
| Compatibility gap | 5 legacy routes matching the V2 resources | unbounded service reads retained temporarily |

ENG-035 remains partially resolved because the five legacy compatibility routes are still unbounded. Removal window: instrument calls, deploy V2 owners, require 14 consecutive days with zero legacy list calls, then remove in the next deployment window; earliest target is Phase 6B. Roll back by restoring the compatibility route registrations and legacy response schemas from the pre-removal release while leaving V2 routes intact.

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
