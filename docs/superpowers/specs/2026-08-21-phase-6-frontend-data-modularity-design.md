# Phase 6 Frontend Data and Modularity Design

Date: 2026-08-21

## 1. Purpose

Phase 6 makes Loomic's frontend data access and high-complexity product surfaces easier to extend without weakening the authority, consistency, and recovery guarantees established in Phases 1 through 5.

The phase is divided into three independently accepted subphases:

- **6A - Server-state data layer and pagination:** introduce a single query runtime, stable cache semantics, and cursor-based list contracts.
- **6B - Domain API modules:** replace the monolithic Web API facade with domain clients over one transport and error boundary.
- **6C - Incremental Chat and Canvas modularization:** separate orchestration, domain state machines, adapters, and views without a behavior or visual redesign.

Each subphase must leave the repository releasable. Shared-core changes are sequential: 6A, then 6B, then 6C.

## 2. Context and Problems

The current Web application has a validated HTTP transport and shared Zod contracts, but server state is still commonly coordinated through component-local `useEffect`, loading flags, request refs, and bespoke invalidation. The 506-line `server-api.ts` exports more than 30 operations across unrelated domains. Chat and Canvas remain large integration points: `chat-sidebar.tsx` is approximately 1,577 lines and `canvas-editor.tsx` approximately 895 lines.

The engineering issues most directly addressed are:

- ENG-038: fragmented frontend server-state caching and invalidation.
- ENG-035: inconsistent or absent pagination for list APIs.
- ENG-007: concentrated responsibilities in Chat, Canvas, and related modules.
- ENG-020: incomplete runtime response validation.
- ENG-019: remaining duplicate orchestration at application boundaries.

Phase 6 does not claim that every historical Canvas issue is closed. Its issue disposition is explicit:

| Issue | Phase 6 disposition |
| --- | --- |
| ENG-007 | Targeted for closure after Chat/Canvas responsibility and ownership gates pass |
| ENG-019 | Reassess after Query commands and controllers replace remaining Web entry orchestration; close only if no duplicate business workflow remains |
| ENG-020 | Targeted for closure after every structured Web API response is schema-validated and binary responses use explicit contracts |
| ENG-035 | Targeted for closure after Projects, Brand Kits, credit transactions, sessions, and messages are paginated and the route inventory proves every other collection is paginated or intrinsically bounded |
| ENG-038 | Targeted for closure after the HTTP-reloadable resource inventory uses the single Query authority |
| ENG-012, ENG-014 | Retain the Phase 4 disposition unless implementation evidence proves additional closure; Phase 6 does not redesign the node protocol or registry |
| ENG-013, ENG-016, ENG-018 | May be marked partially solved only with direct adapter, asset-lifecycle, or test evidence from 6C |
| ENG-015 | Remains open and out of scope; Phase 6 does not change deleted-element persistence semantics |

## 3. Goals and Non-goals

### Goals

- Give HTTP-reloadable server state one cache and invalidation authority.
- Define stable, tenant-safe cursor pagination for growing collections.
- Make API domains independently understandable and testable while preserving one transport and error model.
- Reduce Chat and Canvas orchestration concentration through behavior-preserving extraction.
- Preserve Agent recovery, Canvas CAS, durable realtime replay, and authenticated resource isolation.
- Add safe operational diagnostics for request, cache, mutation, and recovery decisions.

### Non-goals

- A visual redesign or new product navigation.
- A global client-state store.
- Moving Excalidraw instance state or Agent token streams into the query cache.
- Replacing Canvas revision CAS, Phase 5 cursor replay, or the Agent/WebSocket protocol.
- CRDT or multi-author realtime editing.
- A repository-wide design-system extraction into `packages/ui`.
- Phase 7 tracing, metrics, load testing, or release exercises.
- Unrelated historical lint-warning cleanup.

## 4. Chosen Architecture

Use TanStack Query for HTTP-reloadable server state, domain API modules over the existing validated transport, and incremental controller/view extraction for Chat and Canvas.

```text
Pages and composition components
                |
                v
Domain controller hooks
                |
                v
Query layer / command layer / realtime coordination
                |
                v
Domain API modules
                |
                v
Validated HTTP transport
                |
                v
Shared Zod contracts and server application use cases
```

Rejected alternatives:

- A custom query cache would require Loomic to own request deduplication, retry, garbage collection, mutation rollback, pagination, and their race-condition test matrix.
- A Server Components-first rewrite would introduce competing server and client cache authorities across highly interactive Canvas, WebSocket, Supabase-token, and Agent-stream workflows.

## 5. State Authority Matrix

| State | Authority | Notes |
| --- | --- | --- |
| HTTP-reloadable resources | TanStack Query | Resources classified in the Phase 6 inventory below |
| Agent streaming run | Agent Run Controller | ACK, tokens, tool events, stop, terminal state, and recovery |
| Canvas local editing | Canvas Controller and Excalidraw instance | Never mirrored as a general query cache |
| Persisted Canvas version | Existing revision CAS | Conflicts remain explicit and are not blindly retried |
| Cross-replica Canvas events | Phase 5 PostgreSQL cursor replay | Database state is authoritative; notification is a wake-up hint |
| Component presentation state | Local React state | Menus, selection, draft input, and transient disclosure |

One logical state must not have two generic owners. Cross-authority coordination occurs only through explicit controller actions.

### 5.1 Initial Resource Inventory

| Resource or operation | Phase 6 owner and treatment |
| --- | --- |
| Viewer/profile and personal workspace | User-scoped Query bootstrap; profile mutation updates or invalidates Viewer |
| Project list and project detail | Workspace-scoped Query; versioned list pagination; create/update/archive/thumbnail commands precisely update or reset affected keys |
| Initial Canvas snapshot and save | Canvas controller/CAS exception; not a generic Query mutation |
| Chat sessions and persisted messages | Workspace/Canvas/session-scoped infinite Query; versioned pagination; Agent overlay remains controller-owned |
| Workspace settings | Workspace-scoped Query and mutation |
| Credits balance, subscription, and transaction history | Workspace-scoped Query; transaction history receives cursor pagination so the current fixed limit does not make older history unreachable |
| Brand kits | Workspace-scoped Query with cursor pagination; the current unbounded collection read is removed |
| Public Agent model catalog | Public deployment-scoped Query key; response does not vary by identity |
| Image/video model catalogs | Anonymous key when signed out; user/workspace key when signed in because `accessible` varies by plan. The authenticated domain client must send the current bearer token, and auth/plan changes invalidate these catalogs |
| Jobs and generated-asset attachment status | Existing bounded polling/reconciliation controllers; Query adoption is allowed only if it preserves the Phase 2/5 terminal and attachment recovery authority |
| Uploads, asset deletion, generation submission, and run creation | Commands, not cached queries; retries require their existing idempotency guarantees |
| Signed/external media bodies | Asset/media adapter exception with bounded binary validation |

## 6. Subphase 6A: Server-state Data Layer and Pagination

### 6.1 Query Runtime

- Mount one `QueryClientProvider` inside the root `Providers` tree, below `AuthProvider` and above every route that consumes server state. It must cover both the `(workspace)` route group and the standalone `/canvas` route; the workspace layout alone is not a sufficient boundary.
- Do not refresh all data merely because the window regains focus.
- Retry queries at most two additional times for network failures and explicitly retryable 5xx responses, using exponential backoff with jitter capped at two seconds. Generic policy does not retry 429; a domain hook may honor a valid bounded `Retry-After` only when its UX explicitly represents the wait.
- Disable mutation retries by default. A mutation may retry only when its application use case has a stable idempotency key and the test suite proves that an ambiguous response cannot duplicate the effect.
- Do not automatically retry 401, 403, 409, or 422 responses.
- Preserve the existing authentication-expiry transition for 401 responses.
- Bind each `QueryClient` instance to one authenticated user ID, not the access token: token refresh must not recreate the client. On logout or user-ID change, cancel in-flight work, detach the old provider/client instance, and clear it before the next identity becomes visible. A late result from the old client can then update only an unreachable cache. The current product exposes one personal workspace; future workspace switching must remove the previous workspace scope before rendering the next one.
- Query functions obtain the current access token at execution time through an auth-owned token getter and forward TanStack Query's `AbortSignal` to the transport. They must not close over the token present when the hook first rendered. A token refresh changes neither the query key nor cached resource identity.
- Treat Viewer as the authenticated bootstrap query. Resource queries, including `/canvas`, remain disabled until Viewer supplies the authoritative workspace ID; implementations must not use `undefined`, an empty string, or a route parameter as a substitute tenant key.

### 6.2 Query Keys

A central factory owns all keys. Components must not assemble raw key arrays.

Every authenticated key includes `userId`; every tenant resource key also includes `workspaceId`. Canvas and Chat resources additionally include their owning `canvasId` or `sessionId`. Filters and normalized pagination inputs are part of list keys. No identity-derived response may use a process-global key, including Viewer or tier-annotated image/video model catalogs. Truly public deployment catalogs use an explicit `public` key namespace.

Representative hierarchy:

```text
user/{userId}/viewer
user/{userId}/workspace/{workspaceId}/projects/{filters}
user/{userId}/workspace/{workspaceId}/project/{projectId}
user/{userId}/workspace/{workspaceId}/canvas/{canvasId}/sessions
user/{userId}/workspace/{workspaceId}/canvas/{canvasId}/session/{sessionId}/messages
user/{userId}/workspace/{workspaceId}/credits
user/{userId}/workspace/{workspaceId}/brand-kits/{filters}
public/models/agent
anonymous/models/{image|video}
user/{userId}/workspace/{workspaceId}/models/{image|video}
```

### 6.3 Query and Mutation Hooks

Domain hooks such as `useProjectsQuery` and `useMessagesInfiniteQuery` own server-state semantics. Components no longer reproduce request lifecycle state with `useEffect`, loading flags, and request refs.

Mutation policy is explicit per operation:

- Update cache directly when the server returns a complete authoritative resource and list membership/order cannot change.
- Precisely invalidate affected lists when membership, ordering, permissions, or server-derived fields can change.
- Remove both detail and list entries for deletion.
- Use optimistic updates only when rollback is deterministic and covered by tests.
- Do not route Canvas snapshot saves through a generic query mutation; the existing CAS persistence coordinator remains authoritative.

### 6.4 Cursor Pagination

Projects, sessions, and persisted messages adopt the shared shape:

```ts
type CursorPage<T> = {
  items: T[];
  nextCursor: string | null;
};
```

Requests use `cursor` and `limit`; the shared default is 50 and the hard maximum is 100. Cursors are opaque to the browser, authenticated against tampering, and versioned on the server. Cursor decoding validates the user/workspace scope, owner resource, filter fingerprint, sort definition, direction, issue time, and version. Cursors expire after seven days. A malformed, expired, or wrong-scope cursor is rejected with the stable `invalid_cursor` application code before the collection query. Stable ordering uses an indexed time/order column plus the unique resource ID as a tie-breaker; the cursor captures both values.

Projects and sessions are ordered newest-first and page toward older records. The first Chat message request returns the newest bounded history window in chronological display order; `nextCursor` loads the immediately older window, which is prepended without reordering the current live tail. New messages are appended through the authoritative persistence/recovery path and cannot shift the older-history cursor boundary.

Projects and sessions retain their current activity ordering by `updated_at DESC, id DESC`. Because `updated_at` is mutable, any successful local mutation that can change it resets that collection to its first page. Page assembly deduplicates by ID as a defensive measure. A row changed by another client is allowed to reappear only after the collection's explicit invalidation or stale refetch; Phase 6 does not claim snapshot isolation across multiple HTTP page requests.

Brand Kits retain `created_at ASC, id ASC`; credit transactions use `created_at DESC, id DESC`. Chat messages use `created_at DESC, id DESC` for database traversal and reverse each returned window for chronological display. An `invalid_cursor` response discards only the affected page chain and refetches its first page; it does not clear unrelated caches or the Agent ephemeral overlay.

The existing Chat service performs adjacent-message compatibility deduplication only after reading the full ascending history. Before pagination is enabled, all current message writers must use stable IDs with idempotent insert/upsert semantics: the browser creates one UUID for a user message before rendering or persisting it, and the server uses the Agent `runId` as the assistant message ID for the initial write and every fallback. The same IDs key the ephemeral overlay, so persistence acknowledgement replaces rather than duplicates the optimistic item.

A forward migration adds a server-managed nullable `superseded_by` reference to `chat_messages`. It identifies legacy adjacent assistant duplicates using the current compatibility equivalence rule and marks the lifecycle-poorer record as superseded by the richer record (then uses the lexicographically lower ID as deterministic tie-break). It never deletes message content. Both legacy and versioned reads return only canonical rows, while an operator can audit or reverse the marking. After the migration, pagination and client merging deduplicate only by stable message ID; content-text equivalence is removed from the runtime read path. The migration requires fixture coverage, a read-only production preflight query, affected-row logging, column-level privilege tests, and a forward-fix runbook that clears an incorrect marker without reconstructing content.

Authorization is applied before returning items or cursor metadata. Database indexes must match each authorized filter and tuple ordering. Server tests use concurrent inserts and identical timestamps to prove page continuity and tie-break behavior.

The server environment contract adds an active cursor signing key ID and secret plus an optional previous key ID/secret pair. Configuration parsing requires the pair together, rejects equal key IDs, and enforces the repository's secret-strength policy. Encoders always use the active key; decoders accept only the active and optional previous key. Environment templates, Railway contracts, startup validation, redaction, and rotation tests are part of 6A. The previous key is removed only after the maximum cursor lifetime and deployed Web rollback window have elapsed.

Pagination is delivered through additive versioned read endpoints: `GET /api/v2/projects`, `GET /api/v2/brand-kits`, `GET /api/v2/credits/transactions`, `GET /api/v2/canvases/:canvasId/sessions`, and `GET /api/v2/sessions/:sessionId/messages`. Each has a named request schema and a named `CursorPage` response schema in `@loomic/shared`. Existing unpaginated endpoints retain their response shape during the compatibility window. The Web migrates to the versioned endpoint domain by domain. The Phase 6 verification record names the first production release that contains no legacy consumer; the unpaginated reads are removed after that release and its immediately following Web rollback window. This preserves independent API/Web deployment and permits a Web rollback without reverting the new database contract.

Migration begins with Projects, then Brand Kits and credit transactions, then sessions, then messages. Viewer and Settings are singleton resources and are not pagination work. At the start of 6A, a route-level collection inventory classifies every remaining GET collection as cursor-paginated or intrinsically bounded (for example, a sealed deployment catalog with a tested maximum). ENG-035 cannot close while an unbounded collection read remains; removed dynamic-Skill routes are not reintroduced merely to satisfy the historical issue text.

### 6.5 Realtime Coordination

WebSocket handlers may:

- write a complete, contract-validated resource or event result to its exact cache entry;
- invalidate a precise domain key;
- delegate Agent and Canvas events to their dedicated controllers.

They must not clear the entire query cache or use refetching to conceal a Phase 5 cursor gap.

## 7. Subphase 6B: Domain API Modules

### 7.1 Target Structure

```text
apps/web/src/lib/api/
  transport.ts
  errors.ts
  viewer.ts
  projects.ts
  canvas.ts
  chat.ts
  generation.ts
  assets.ts
  credits.ts
  models.ts
  brand-kits.ts
```

- `transport.ts` owns URL construction, authentication headers, timeout/abort behavior, JSON decoding, and success/error envelope validation.
- `errors.ts` owns stable public error types such as `ApiAuthError` and `ApiApplicationError`.
- Domain modules own only request construction and shared-contract binding for that domain.
- Query hooks live outside the low-level API modules.
- API modules do not access React state, routing, notifications, or the QueryClient.

All successful structured Loomic API responses must pass a named `@loomic/shared` Zod schema before reaching product code. Binary responses use an explicit transport contract that validates status, declared content type, and a bounded body size before exposing a `Blob` or stream. Components must not call Loomic API endpoints with raw `fetch`; external or signed media URLs are accessed only through the asset/media adapter and its bounded response policy.

### 7.2 Dependency Rule

Domain API modules do not call one another. Cross-domain workflows are composed by an application-level controller or command. This prevents the split modules from becoming a cyclic dependency graph.

### 7.3 Compatibility Migration

1. Preserve the current transport and public error behavior while moving them to the target boundary. The root Query provider and first domain clients needed by 6A may be created in their final `lib/api` locations; 6B migrates the remaining domains rather than moving the 6A code again.
2. Extract one domain at a time with focused contract tests.
3. Keep `server-api.ts` temporarily as re-exports only; it must contain no second implementation.
4. New code imports domain modules directly.
5. Migrate all checked-in consumers and delete the Web `server-api.ts` compatibility facade within 6B. This in-repository facade is separate from the deployed legacy HTTP read endpoints and needs no release compatibility window.
6. Add an architecture gate against raw Loomic API fetches, unchecked response JSON, cross-domain API calls, and a new all-domain facade.

## 8. Subphase 6C: Incremental Chat and Canvas Modularization

### 8.1 Principles

- Extract one responsibility or side-effect owner at a time.
- Preserve user-visible behavior and layout.
- Lock current recovery and concurrency behavior with tests before moving ownership.
- Extract pure functions first, controllers second, and views last.
- Do not extract components that only forward a large prop surface without owning a coherent view responsibility.
- File length is a diagnostic, not an acceptance target.

### 8.2 Chat Boundaries

```text
components/chat/
  chat-sidebar.tsx
  chat-message-list.tsx
  chat-composer.tsx
  chat-run-status.tsx
  tool-block-view.tsx

features/chat/
  use-chat-controller.ts
  use-agent-run-controller.ts
  use-chat-recovery.ts
  chat-event-reducer.ts
  chat-message-merge.ts
  types.ts
```

- `chat-sidebar.tsx` becomes the composition and layout boundary.
- `chat-message-list.tsx` uses `@tanstack/react-virtual` to virtualize loaded durable history while preserving keyboard access, message error boundaries, bottom-follow behavior, dynamic message measurement, and scroll anchoring when an older page is prepended. The implementation follows the official React Virtualizer API rather than maintaining a custom windowing engine.
- `use-chat-controller` coordinates session selection, persisted message queries, and commands.
- `use-agent-run-controller` owns acceptance, ACK correlation, streaming, stop, and terminal state.
- `use-chat-recovery` owns reconnect, replay, and unconfirmed-finalization recovery.
- Event reduction and message merging are pure and tested against duplicates, reordering, and replay.
- The persisted message pages in Query are the durable timeline. The Agent controller owns only an ephemeral overlay keyed by stable message/run ID for the pending user command, assistant placeholder, streamed blocks, and recovery status. The rendered timeline is a pure projection of durable pages plus this overlay. Authoritative persistence evidence replaces/removes the matching overlay entry by ID; a precise invalidation reloads the durable record. The controller must not maintain a second full copy of persisted history.

### 8.3 Canvas Boundaries

```text
components/canvas/
  canvas-editor.tsx
  canvas-surface.tsx
  canvas-overlays.tsx
  canvas-loading-state.tsx

features/canvas/
  use-canvas-controller.ts
  use-canvas-persistence.ts
  use-canvas-realtime.ts
  use-canvas-assets.ts
  excalidraw-adapter.ts
  types.ts
```

- `canvas-editor.tsx` remains the public composition entry.
- `canvas-surface.tsx` owns the Excalidraw rendering boundary.
- Persistence retains revision CAS, queued saves, conflict handling, and durable acknowledgement.
- Realtime retains cursor tracking, replay, and remote operation application.
- Assets retain media resolution, object URL lifetime, and generated-attachment recovery.
- `excalidraw-adapter.ts` contains third-party-to-domain translation; Loomic domain modules do not spread Excalidraw-specific assumptions.

Phase 6 does not create a second Canvas state store or persistence path.

### 8.4 Extraction Order

1. Add regression tests for current run recovery, replay, CAS, and generated assets.
2. Extract pure reducers, merge functions, and types without moving state ownership.
3. Extract read-only controller hooks.
4. Move one side effect at a time, deleting the former owner in the same change.
5. Split coherent view components after controller interfaces stabilize.
6. Remove compatibility paths and enforce ownership through tests and architecture checks.

## 9. Error Handling and Diagnostics

The transport distinguishes network failure, timeout, malformed JSON, invalid response schema, canonical HTTP application errors, and caller abort. Domain API modules preserve stable error codes rather than branching on message text.

The Query layer decides retry, invalidation, optimistic rollback, and stale-data behavior. Domain controllers decide Agent and Canvas recovery. Pages choose user-facing messages and recovery actions.

Canvas 409 conflicts remain visible to the CAS coordinator and are never automatically retried by the generic Query runtime. WebSocket disconnects continue through Phase 5 cursor replay.

Structured logs record domain, operation, status, duration, stable error code, request ID when available, cache action, and invalidation target. They must not contain access tokens, message bodies, uploaded content, prompts, or Canvas snapshots.

## 10. Extensibility Rules

The architecture is considered extensible only while these rules remain enforced:

1. **Tenant-scoped keys:** every workspace resource cache key carries `workspaceId`; subordinate resources carry their owner identifiers.
2. **No lateral domain API dependencies:** cross-domain workflows are composed above domain clients.
3. **Versioned opaque cursors:** one server cursor codec emits an HMAC-authenticated payload containing a key ID, version, tenant/owner scope, filters, direction, ordering, and tuple boundary. Verification uses a dedicated environment-managed cursor signing key, supports current plus previous key during rotation, and rejects invalid cursors before issuing the collection query.
4. **Cohesive extraction:** modules are split by independent responsibility and test value, not an arbitrary line count.

Under these rules, a new resource domain adds a shared contract, server use case/route, domain API client, key factory entry, and domain Query/Command hooks without expanding unrelated modules.

## 11. Testing and Acceptance

### 11.1 Automated Coverage

- Shared contracts: cursor inputs, bounded limits, page envelopes, and invalid cursors.
- Server: stable ordering, authorization isolation, concurrent inserts, page continuity, and no duplicates.
- API modules: request construction, response validation, abort/timeout, and canonical error mapping.
- Query hooks: deduplication, tenant keys, current-token reads, cancellation, old-user late-result isolation, retry policy, exact invalidation, mutations, logout cleanup, and auth expiry.
- Chat controllers: ACK correlation, duplicate/out-of-order events, stop, terminal persistence, disconnect, and replay.
- Canvas controllers: revision conflicts, queued saves, cursor gaps, remote events, asset resolution, and recovery.
- Browser workflows: project pagination, Chat history pagination, Agent stop/recovery, Canvas save conflict, and authenticated workspace switching when supported.

### 11.2 Subphase Gates

Every subphase must pass `pnpm ci:check` and `git diff --check`. Changes to database or HTTP pagination contracts additionally require a clean database reset, pgTAP, and relevant real-PostgreSQL integration tests. Phase 3-5 authorization, fencing, replay, and persistence regression suites remain mandatory.

### 11.3 Completion Conditions

- Every HTTP-reloadable resource listed in the Phase 6 implementation inventory uses a domain Query hook rather than component-local request lifecycle orchestration. The inventory explicitly records deliberate exceptions such as Canvas CAS snapshots, Agent streaming state, binary media fetches, and authentication bootstrap internals.
- Projects, sessions, and messages use the accepted cursor contract.
- Loomic HTTP calls pass through domain modules and the validated transport.
- The Web `server-api.ts` compatibility facade is removed; the Phase 6 verification record separately identifies the deployed legacy HTTP endpoint removal release and rollback window.
- Chat and Canvas composition entries no longer orchestrate low-level HTTP details.
- Each side effect has one documented owner.
- Critical browser workflows pass with no intended visual redesign.
- Projects, Brand Kits, and session collections request their next page from an existing scroll surface or a restrained load-more control; Chat requests older messages at the history boundary and preserves the reader's scroll anchor.
- The engineering issue register records closed, partially solved, and deliberately retained scope with verification evidence.

## 12. Delivery and Rollback

- Deliver one domain or one side-effect ownership transfer per behavioral change.
- Do not use long-lived dual writes or duplicate caches.
- A compatibility facade may re-export functions but cannot retain parallel logic.
- Query hooks are enabled page by page; rollback restores the previous hook against the still-live legacy endpoint. A rollback must not depend on interpreting the new page envelope as the old response.
- Pagination compatibility remains only for a documented migration window covering independent API and Web deployment plus one Web rollback release.
- Each subphase receives its own implementation plan and verification record before the next subphase changes shared boundaries.
