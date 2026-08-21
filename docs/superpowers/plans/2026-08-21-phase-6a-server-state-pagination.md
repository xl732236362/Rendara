# Phase 6A Server-State and Pagination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish an identity-safe TanStack Query runtime and cursor-paginated Projects, Brand Kits, credit transactions, Chat sessions, and Chat messages without weakening existing authentication, Agent recovery, or Canvas CAS behavior.

**Architecture:** The root Web provider owns one QueryClient per authenticated user and query functions read the current token at execution time. Additive `/api/v2` collection reads use shared page contracts and an HMAC cursor codec; legacy reads remain unchanged for deployment rollback. Chat history becomes stable-ID based, with legacy duplicates reversibly marked rather than deleted.

**Tech Stack:** TypeScript, React 19, Next.js 15, TanStack Query 5.101.4, Fastify 5, Zod 4, Supabase/PostgreSQL, Vitest, pgTAP, Playwright.

**Design source:** `docs/superpowers/specs/2026-08-21-phase-6-frontend-data-modularity-design.md`

---

## File Map

- `packages/shared/src/pagination.ts`: shared page/query schemas and stable `invalid_cursor` code.
- `apps/server/src/pagination/cursor-codec.ts`: signed cursor encode/decode, scope and expiry validation.
- `apps/server/src/pagination/keyset.ts`: typed tuple-boundary helpers.
- `apps/server/src/features/*`: paged service methods; legacy methods remain during compatibility.
- `apps/server/src/http/*`: additive `/api/v2` read routes only.
- `supabase/migrations/20260823000001_phase6a_pagination.sql`: indexes and reversible `superseded_by` metadata.
- `apps/web/src/lib/query/*`: identity lifecycle, key factory, retry policy, and domain hooks.
- `apps/web/src/lib/api/*`: only the domain clients required by 6A; 6B migrates the remaining facade.

### Task 1: Add Query Dependencies and Identity Lifecycle

**Files:**
- Modify: `apps/web/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `apps/web/src/lib/query/query-client.ts`
- Create: `apps/web/src/lib/query/query-provider.tsx`
- Create: `apps/web/test/query-provider.test.tsx`
- Modify: `apps/web/src/components/providers.tsx`
- Modify: `apps/web/src/lib/auth-context.tsx`

- [ ] **Step 1: Write failing provider tests**

Test that `(a)` `/canvas` descendants can use QueryClient, `(b)` token refresh retains the client/cache, `(c)` user-ID change mounts a new client, and `(d)` an aborted old-user query cannot populate the new client. Use a probe with `useQuery({ queryKey: ["probe"], queryFn: ({ signal }) => deferred(signal) })` and expose the client identity through `useQueryClient()`.

- [ ] **Step 2: Verify the tests fail**

Run: `pnpm --filter @loomic/web test -- test/query-provider.test.tsx`

Expected: FAIL because `IdentityQueryProvider` does not exist.

- [ ] **Step 3: Install and implement the runtime**

Run: `pnpm --filter @loomic/web add @tanstack/react-query@5.101.4`

Implement `createLoomicQueryClient()` with at most two additional query attempts for network/retryable 5xx only, capped jittered backoff, `refetchOnWindowFocus: false`, and `mutations.retry: false`. `IdentityQueryProvider` reads `user?.id`, creates a client keyed only by that ID, cancels and clears the prior client on identity change, and passes the current token through a stable getter context. Place it below `AuthProvider` in root `Providers`, not in `(workspace)/layout.tsx`.

- [ ] **Step 4: Verify provider behavior**

Run: `pnpm --filter @loomic/web test -- test/query-provider.test.tsx test/auth-context.test.tsx`

Expected: PASS; token change preserves cache, identity change isolates it.

- [ ] **Step 5: Commit**

Run: `git add apps/web/package.json pnpm-lock.yaml apps/web/src/lib/query apps/web/src/components/providers.tsx apps/web/src/lib/auth-context.tsx apps/web/test/query-provider.test.tsx && git commit -m "feat(web): add identity-safe query runtime"`

### Task 2: Add Shared Pagination Contracts and Cursor Environment

**Files:**
- Create: `packages/shared/src/pagination.ts`
- Create: `packages/shared/src/pagination.test.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/config/src/env.ts`
- Modify: `packages/config/src/env.test.ts`
- Modify: `.env.example`
- Modify: `deploy/environment-contract.json`
- Modify: `scripts/validate-env-template.mjs`

- [ ] **Step 1: Write failing contract/config tests**

Define expected parsing for `{ limit: 50 }`, maximum 100, opaque cursor maximum length 4096, `CursorPage<T>`, and active/previous signing-key pairing. Assert API startup rejects missing active key, weak secrets, equal key IDs, and half-configured previous keys.

- [ ] **Step 2: Verify red state**

Run: `pnpm --filter @loomic/shared test -- src/pagination.test.ts && pnpm --filter @loomic/config test -- src/env.test.ts`

Expected: FAIL because pagination exports and environment descriptors are absent.

- [ ] **Step 3: Implement contracts and configuration**

Export `paginationQuerySchema`, `createCursorPageSchema(itemSchema)`, `CursorPage<T>`, and `invalidCursorErrorCodeSchema`. Add required API properties `paginationCursorActiveKeyId` and `paginationCursorActiveKey`, plus optional paired previous values. Require secrets of at least 32 bytes after UTF-8 encoding. Add redacted template placeholders and deployment descriptors.

- [ ] **Step 4: Verify contracts and templates**

Run: `pnpm --filter @loomic/shared test -- src/pagination.test.ts && pnpm --filter @loomic/config test -- src/env.test.ts && pnpm validate:env`

Expected: PASS with environment contract validation.

- [ ] **Step 5: Commit**

Run: `git add packages/shared packages/config .env.example deploy/environment-contract.json scripts/validate-env-template.mjs && git commit -m "feat(contracts): add signed pagination contract"`

### Task 3: Implement and Test the Cursor Codec

**Files:**
- Create: `apps/server/src/pagination/cursor-codec.ts`
- Create: `apps/server/src/pagination/cursor-codec.test.ts`
- Create: `apps/server/src/pagination/keyset.ts`
- Create: `apps/server/src/pagination/keyset.test.ts`

- [ ] **Step 1: Write failing codec tests**

Cover HMAC tampering, active/previous key decoding, seven-day expiry, wrong user/workspace/owner/filter/direction, unknown key ID, 4096-byte input bound, identical timestamps, ascending and descending tuples. The public API is:

```ts
type CursorScope = {
  userId: string;
  workspaceId: string;
  owner: string;
  filterHash: string;
  direction: "asc" | "desc";
};

createCursorCodec(keys, clock).encode(scope, { timestamp, id }): string;
createCursorCodec(keys, clock).decode(cursor, expectedScope): { timestamp: string; id: string };
```

- [ ] **Step 2: Verify red state**

Run: `pnpm --filter @loomic/server test -- src/pagination/cursor-codec.test.ts src/pagination/keyset.test.ts`

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement minimal codec and tuple helpers**

Use `node:crypto` `createHmac("sha256", key)` and `timingSafeEqual`. Encode base64url JSON payload plus signature; never log payload or signature. Map every decode failure to `AppError({ code: "invalid_cursor", statusCode: 400 })`. Keyset helpers generate the exact `(timestamp < boundary) OR (timestamp = boundary AND id < boundaryId)` predicate, reversed for ascending order.

- [ ] **Step 4: Verify codec**

Run: `pnpm --filter @loomic/server test -- src/pagination/cursor-codec.test.ts src/pagination/keyset.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add apps/server/src/pagination && git commit -m "feat(server): add scoped cursor codec"`

### Task 4: Add Database Indexes and Reversible Chat Canonicalization

**Files:**
- Create: `supabase/migrations/20260823000001_phase6a_pagination.sql`
- Create: `supabase/tests/phase_6a_pagination.test.sql`
- Create: `docs/tech/phase-6a-message-canonicalization-runbook.md`

- [ ] **Step 1: Write failing pgTAP assertions**

Assert `chat_messages.superseded_by` exists, authenticated cannot update it, canonical indexes exist for every tuple order, superseded rows remain stored, and the canonical view/query excludes them. Seed equal-content adjacent assistant fixtures where richer lifecycle data wins and equal richness chooses the lower ID.

- [ ] **Step 2: Verify database tests fail**

Run: `supabase test db --file supabase/tests/phase_6a_pagination.test.sql`

Expected: FAIL because the column and indexes do not exist.

- [ ] **Step 3: Implement forward migration**

Add `superseded_by uuid null references public.chat_messages(id) on delete restrict`, a constraint preventing self-reference, partial canonical indexes for messages and the required keyset indexes for Projects, Brand Kits, credit transactions, and sessions. Backfill only adjacent assistant duplicates using the existing richness rule translated into deterministic SQL; update losers, never delete. Revoke column update from authenticated roles. Document preflight count, affected-row inspection, clearing incorrect markers, and key rotation order.

- [ ] **Step 4: Reset and verify database**

Run: `supabase db reset --yes && supabase test db && supabase db lint --level warning`

Expected: all migrations apply, pgTAP passes, no schema lint errors.

- [ ] **Step 5: Commit**

Run: `git add supabase/migrations/20260823000001_phase6a_pagination.sql supabase/tests/phase_6a_pagination.test.sql docs/tech/phase-6a-message-canonicalization-runbook.md && git commit -m "feat(db): add phase 6a pagination indexes"`

### Task 5: Add Paged Project, Brand Kit, and Credit Services

**Files:**
- Modify: `apps/server/src/features/projects/project-service.ts`
- Create: `apps/server/src/features/projects/project-service.pagination.test.ts`
- Modify: `apps/server/src/features/brand-kit/brand-kit-service.ts`
- Create: `apps/server/src/features/brand-kit/brand-kit-service.pagination.test.ts`
- Modify: `apps/server/src/features/credits/credit-service.ts`
- Create: `apps/server/src/features/credits/credit-service.pagination.test.ts`

- [ ] **Step 1: Write failing service tests**

For each service, request `limit + 1`, assert exact order (`updated_at DESC,id DESC` for Projects; `created_at ASC,id ASC` for Brand Kits; `created_at DESC,id DESC` for transactions), trim to limit, and generate `nextCursor` from the final returned item. Assert workspace authorization precedes cursor use and signed wrong-scope cursors fail before collection access.

- [ ] **Step 2: Verify red state**

Run: `pnpm --filter @loomic/server test -- src/features/projects/project-service.pagination.test.ts src/features/brand-kit/brand-kit-service.pagination.test.ts src/features/credits/credit-service.pagination.test.ts`

Expected: FAIL because paged methods are absent.

- [ ] **Step 3: Implement paged methods without changing legacy methods**

Add `listProjectsPage`, `listKitsPage`, and `listTransactionsPage` returning `CursorPage`. Inject `CursorCodec`; do not read environment inside services. Preserve existing resource mapping and primary-Canvas/thumbnail enrichment only for the current project page.

- [ ] **Step 4: Verify services**

Run the command from Step 2.

Expected: PASS, including identical-timestamp fixtures.

- [ ] **Step 5: Commit**

Run: `git add apps/server/src/features/projects apps/server/src/features/brand-kit apps/server/src/features/credits && git commit -m "feat(server): paginate workspace collections"`

### Task 6: Stabilize Chat Message IDs and Add Chat Paging

**Files:**
- Modify: `apps/server/src/ws/handler.ts`
- Modify: `apps/server/src/ws/handler.authorization.test.ts`
- Modify: `apps/server/src/features/chat/chat-service.ts`
- Modify: `apps/server/src/features/chat/chat-service.test.ts`
- Create: `apps/server/src/features/chat/chat-service.pagination.test.ts`
- Modify: `apps/web/src/components/chat-sidebar.tsx`
- Modify: `apps/web/test/chat-sidebar.test.tsx`

- [ ] **Step 1: Write failing stable-ID tests**

Assert server assistant persistence uses `runId` for every retry, browser user persistence uses one `crypto.randomUUID()` for optimistic render and POST, fallback uses the same run ID, and canonical reads exclude `superseded_by` rows.

- [ ] **Step 2: Write failing paging tests**

Assert sessions page newest-to-oldest; initial message page queries newest rows but returns chronological display order; next page prepends older rows; identical timestamps use ID; canonical rows appear once; newly appended live rows do not alter the older cursor.

- [ ] **Step 3: Verify red state**

Run: `pnpm --filter @loomic/server test -- src/features/chat/chat-service.test.ts src/features/chat/chat-service.pagination.test.ts src/ws/handler.authorization.test.ts && pnpm --filter @loomic/web test -- test/chat-sidebar.test.tsx`

Expected: FAIL on random server persistence ID, missing browser message ID, and absent paged methods.

- [ ] **Step 4: Implement stable IDs and paged methods**

Pass `runId` into `persistAssistantMessage`; use it as `input.id`. Generate the user UUID before `updateSessionMessages` and pass the same ID to `saveMessage`. Add `listSessionsPage` and `listMessagesPage`; filter `.is("superseded_by", null)`, fetch `limit + 1`, and reverse only the returned message window.

- [ ] **Step 5: Verify Chat behavior**

Run the command from Step 3.

Expected: PASS with existing Agent recovery tests unchanged.

- [ ] **Step 6: Commit**

Run: `git add apps/server/src/ws apps/server/src/features/chat apps/web/src/components/chat-sidebar.tsx apps/web/test/chat-sidebar.test.tsx && git commit -m "feat(chat): stabilize message identity for paging"`

### Task 7: Register Additive V2 Routes

**Files:**
- Create: `apps/server/src/http/pagination-routes.test.ts`
- Modify: `apps/server/src/http/projects.ts`
- Modify: `apps/server/src/http/brand-kits.ts`
- Modify: `apps/server/src/http/credits.ts`
- Modify: `apps/server/src/http/chat.ts`
- Modify: `apps/server/src/app.ts`

- [ ] **Step 1: Write failing route tests**

Cover all five exact V2 paths: `/api/v2/projects`, `/api/v2/brand-kits`, `/api/v2/credits/transactions`, `/api/v2/canvases/:canvasId/sessions`, and `/api/v2/sessions/:sessionId/messages`. Also cover default/max limits, invalid cursor envelope, auth before service invocation, page schema parsing, and unchanged legacy response shapes.

- [ ] **Step 2: Verify red state**

Run: `pnpm --filter @loomic/server test -- src/http/pagination-routes.test.ts`

Expected: 404 for V2 paths.

- [ ] **Step 3: Implement routes and composition**

Construct one cursor codec in `app.ts` from parsed environment and inject it into paged services. Parse query with the shared schema and return `{ items, nextCursor }`. Never accept workspace/user scope from query parameters; derive it from authentication and authorized owner resolution.

- [ ] **Step 4: Verify HTTP boundaries**

Run: `pnpm --filter @loomic/server test -- src/http/pagination-routes.test.ts src/http/route-error-migration.test.ts`

Expected: PASS; legacy routes remain green.

- [ ] **Step 5: Commit**

Run: `git add apps/server/src/http apps/server/src/app.ts && git commit -m "feat(api): expose versioned cursor reads"`

### Task 8: Add Query Keys, V2 Domain Clients, and Viewer Bootstrap

**Files:**
- Create: `apps/web/src/lib/api/viewer.ts`
- Create: `apps/web/src/lib/api/projects.ts`
- Create: `apps/web/src/lib/api/brand-kits.ts`
- Create: `apps/web/src/lib/api/credits.ts`
- Create: `apps/web/src/lib/api/chat.ts`
- Create: `apps/web/src/lib/api/models.ts`
- Create: `apps/web/src/lib/query/keys.ts`
- Create: `apps/web/src/lib/query/keys.test.ts`
- Create: `apps/web/src/lib/query/workspace-queries.ts`
- Create: `apps/web/test/workspace-queries.test.tsx`

- [ ] **Step 1: Write failing key/client tests**

Assert every authenticated key includes user/workspace, Chat adds Canvas/session, anonymous and authenticated image/video catalogs differ, filters normalize deterministically, V2 clients parse page schemas, and model clients send the current bearer token when signed in.

- [ ] **Step 2: Verify red state**

Run: `pnpm --filter @loomic/web test -- test/workspace-queries.test.tsx src/lib/query/keys.test.ts`

Expected: FAIL because modules are absent.

- [ ] **Step 3: Implement clients and bootstrap hooks**

Create `useViewerQuery` keyed by user ID. All workspace hooks use `enabled: Boolean(viewer.data?.workspace.id)` and never manufacture a tenant key. Implement infinite-query page params as opaque strings. The token getter and Query `signal` are passed to every API call. Authenticated image/video catalog clients include bearer auth; public Agent models use `public/models/agent`.

- [ ] **Step 4: Verify Query boundaries**

Run the command from Step 2 plus `pnpm --filter @loomic/web test -- test/server-api.test.ts`.

Expected: PASS and legacy facade tests remain green.

- [ ] **Step 5: Commit**

Run: `git add apps/web/src/lib/api apps/web/src/lib/query apps/web/test/workspace-queries.test.tsx && git commit -m "feat(web): add scoped workspace queries"`

### Task 9: Migrate Collection Consumers Incrementally

**Files:**
- Modify: `apps/web/src/app/(workspace)/home/page.tsx`
- Modify: `apps/web/src/app/(workspace)/projects/page.tsx`
- Modify: `apps/web/src/components/brand-kit/brand-kit-page.tsx`
- Modify: `apps/web/src/components/credits/credit-usage-history.tsx`
- Modify: `apps/web/src/app/(workspace)/settings/page.tsx`
- Modify: `apps/web/src/components/agent-model-selector.tsx`
- Modify: `apps/web/src/components/image-model-preference.tsx`
- Modify: `apps/web/src/hooks/use-chat-sessions.ts`
- Modify: `apps/web/src/components/chat-sidebar.tsx`
- Modify: `apps/web/test/projects.test.tsx`
- Modify: `apps/web/test/chat-sidebar.test.tsx`
- Create: `apps/web/test/brand-kit-page.test.tsx`
- Create: `apps/web/test/credit-usage-history.test.tsx`
- Create: `apps/web/test/settings.test.tsx`
- Create: `apps/web/test/model-queries.test.tsx`

- [ ] **Step 1: Add failing consumer tests**

Test Projects/Brand Kits/credits request next pages without duplicate IDs, list mutations reset mutable-order pages, Settings uses the Viewer workspace scope, authenticated image/video catalogs send the current token and invalidate on plan changes, Chat initially shows the newest window in chronological order, loading older history preserves current messages, and invalid cursor resets only that collection.

- [ ] **Step 2: Verify red state**

Run: `pnpm --filter @loomic/web test -- test/projects.test.tsx test/chat-sidebar.test.tsx test/credit-usage-history.test.tsx test/brand-kit-page.test.tsx test/settings.test.tsx test/model-queries.test.tsx`

Expected: at least the new pagination assertions fail.

- [ ] **Step 3: Migrate Projects, Brand Kits, and credits**

Replace local request lifecycle state with domain queries and commands. Use the current scroll surface or one restrained load-more control. Create/update/archive/title mutations invalidate or reset exact keys; do not clear the QueryClient. Migrate Settings and model selectors in the same step so no identity-derived catalog remains under a global or anonymous key after login.

- [ ] **Step 4: Migrate persisted Chat history**

Replace the LRU full-history cache with infinite durable pages. Keep only ephemeral pending/streaming entries in the controller and render a pure ID-based merge. On older-page prepend, preserve the scroll anchor. Do not move WebSocket cursor or Canvas state into Query.

- [ ] **Step 5: Verify consumers**

Run the command from Step 2 and `pnpm --filter @loomic/web test`.

Expected: all Web tests pass.

- [ ] **Step 6: Commit by domain**

Create separate commits: `feat(web): migrate project queries`, `feat(web): paginate workspace catalogs`, and `feat(chat): adopt durable message pages`.

### Task 10: Architecture Gates and Phase 6A Acceptance

**Files:**
- Modify: `tests/workspace.test.mjs`
- Create: `docs/tech/phase-6a-verification.md`
- Modify: `docs/tech/engineering-issues-register.md`
- Modify: `.codemap/modules/web.md`
- Modify: `.codemap/modules/server.md`
- Modify: `.codemap/modules/platform.md`

- [ ] **Step 1: Add failing architecture assertions**

Reject raw Query key arrays outside the key factory, identity-derived global keys, component-local V2 fetches, mutation retry without an allowlisted idempotent command, and unbounded collection services found by the route inventory.

- [ ] **Step 2: Run focused and full gates**

Run:

```powershell
pnpm ci:check
supabase db reset --yes
supabase test db
supabase db lint --level warning
pnpm --filter @loomic/server test:integration
git diff --check
```

Expected: all commands return 0; ordinary Server tests may skip documented database-gated tests, while the explicit integration command passes them.

- [ ] **Step 3: Record evidence and issue status**

Document exact test counts, database results, legacy endpoint compatibility, cursor-key rotation test, collection inventory, and remaining deployment removal window. Close ENG-035 only if every collection is paginated or proven intrinsically bounded. Close ENG-038 only if the resource inventory has a single owner; otherwise mark partial with named gaps.

- [ ] **Step 4: Commit acceptance evidence**

Run: `git add tests/workspace.test.mjs docs/tech .codemap && git commit -m "docs(governance): verify phase 6a data layer"`
