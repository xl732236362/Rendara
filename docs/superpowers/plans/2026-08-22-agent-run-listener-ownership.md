# Agent Run Listener Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move live Agent run ownership from `ChatSidebar` into one canvas-scoped controller that survives sidebar remounts and preserves current recovery behavior.

**Architecture:** `canvas/page.tsx` creates one framework-independent controller per canvas and passes it to `ChatSidebar`. The controller owns one WebSocket event subscription and live run snapshots; a pure reducer remains the single event-to-content rule. Durable chat pages remain Query-owned.

**Tech Stack:** TypeScript, React 19, Next.js, Vitest, Testing Library, existing Loomic WebSocket and shared event contracts.

---

## File Structure

- Create `apps/web/src/lib/agent-run-content.ts`: pure stream-event reducer.
- Create `apps/web/src/lib/agent-run-controller.ts`: canvas-scoped run state, routing, resume, retention, and disposal.
- Create `apps/web/test/agent-run-content.test.ts`: reducer behavior tests.
- Create `apps/web/test/agent-run-controller.test.ts`: lifecycle and routing tests.
- Modify `apps/web/src/hooks/use-chat-stream.ts`: delegate to the shared reducer during compatibility migration.
- Modify `apps/web/src/app/canvas/page.tsx`: create/dispose one controller per canvas.
- Modify `apps/web/src/components/chat-sidebar.tsx`: consume controller and remove per-run listeners.
- Modify `apps/web/test/chat-sidebar.test.tsx`: remount, reconnect, fallback, and terminal behavior.
- Modify governance docs/CODEMAP only after verification.

### Task 1: Extract the Single Run Content Reducer

**Files:**
- Create: `apps/web/src/lib/agent-run-content.ts`
- Create: `apps/web/test/agent-run-content.test.ts`
- Modify: `apps/web/src/hooks/use-chat-stream.ts`

- [ ] **Step 1: Write failing reducer tests**

Cover text/thinking concatenation, tool deduplication and terminal replacement, failed-run fallback text, and canceled-run tool cleanup using `reduceAgentRunContent(blocks, event)`.

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @loomic/web test -- test/agent-run-content.test.ts`

Expected: FAIL because `agent-run-content.ts` does not exist.

- [ ] **Step 3: Implement the pure reducer**

Move the event switch from `useChatStream` without changing messages or statuses. The reducer returns the original array for irrelevant events and a new array only when content changes.

- [ ] **Step 4: Delegate the compatibility hook to the reducer**

`useChatStream` locates the assistant message and replaces only its `contentBlocks` with `reduceAgentRunContent` output.

- [ ] **Step 5: Verify GREEN and commit**

Run: `pnpm --filter @loomic/web test -- test/agent-run-content.test.ts test/chat-sidebar.test.tsx`

Expected: reducer tests and the existing 31 ChatSidebar tests pass.

Commit: `refactor(chat): extract agent run content reducer`

### Task 2: Build the Canvas-Scoped Controller

**Files:**
- Create: `apps/web/src/lib/agent-run-controller.ts`
- Create: `apps/web/test/agent-run-controller.test.ts`

- [ ] **Step 1: Write failing lifecycle tests**

Create a fake `WebSocketHandle` and assert one `onEvent` subscription, run/session routing, snapshot subscription across UI unsubscribe/resubscribe, terminal acknowledgement, 20-item/30-minute pruning, idempotent disposal, persistence fallback, resume gap recovery, and canvas isolation.

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @loomic/web test -- test/agent-run-controller.test.ts`

Expected: FAIL because `createAgentRunController` does not exist.

- [ ] **Step 3: Implement minimal controller**

Use `Map<string, ActiveRun>`, one constructor-time `ws.onEvent`, `Set` subscribers, fixed durable handlers, and injected clock. Route `canvas.sync` separately; route run events only for registered runs. Use the reducer from Task 1. Resume through `ws.resumeCanvas(canvasId, handleResumeAck)` and trigger replay-gap recovery from the ACK payload.

- [ ] **Step 4: Implement bounded terminal retention**

Track `terminalAt`; prune terminal snapshots older than 30 minutes and then oldest entries above 20. Never prune active runs.

- [ ] **Step 5: Verify GREEN and commit**

Run: `pnpm --filter @loomic/web test -- test/agent-run-controller.test.ts test/agent-run-content.test.ts`

Expected: all focused tests pass.

Commit: `feat(chat): add canvas-scoped agent run controller`

### Task 3: Move Canvas and ChatSidebar to the Controller

**Files:**
- Modify: `apps/web/src/app/canvas/page.tsx`
- Modify: `apps/web/src/components/chat-sidebar.tsx`
- Modify: `apps/web/test/chat-sidebar.test.tsx`

- [ ] **Step 1: Add failing integration tests**

Assert the same controller survives ChatSidebar unmount/remount, an acknowledged run continues receiving events while UI is absent, remount reconstructs the same assistant ID/content, canvas change disposes the old subscription, and fallback persistence remains single-shot.

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @loomic/web test -- test/chat-sidebar.test.tsx`

Expected: new lifecycle assertions fail because ChatSidebar still owns `runListenerByRunIdRef`.

- [ ] **Step 3: Compose controller in the canvas page**

Create it once for `{ canvasId, ws }`, pass stable refs for token and callbacks, request resume on connection transition, and dispose only on canvas owner change or page teardown.

- [ ] **Step 4: Migrate ChatSidebar**

Pass `runController`; call `startRun` after ACK; subscribe snapshots into the existing message overlay; drive active/stopping/terminal UI from the snapshot; acknowledge terminal state after durable reload or UI observation. Remove `runListenerByRunIdRef`, `assistantIdByRunIdRef`, and all per-run/replay `ws.onEvent` registrations.

- [ ] **Step 5: Verify GREEN and commit**

Run: `pnpm --filter @loomic/web test -- test/chat-sidebar.test.tsx test/agent-run-controller.test.ts test/use-websocket.test.tsx`

Expected: all focused lifecycle, recovery, and WebSocket tests pass.

Commit: `refactor(chat): move run ownership to canvas controller`

### Task 4: Acceptance and Governance

**Files:**
- Modify: `tests/workspace.test.mjs`
- Modify: `docs/tech/phase-6a-verification.md`
- Modify: `docs/tech/engineering-issues-register.md`
- Modify: `.codemap/modules/web.md`

- [ ] **Step 1: Add a failing architecture assertion**

Reject `ws.onEvent` and `runListenerByRunIdRef` inside `chat-sidebar.tsx`; require `canvas/page.tsx` to compose `createAgentRunController` and the controller module to own the sole run subscription.

- [ ] **Step 2: Verify RED, then align production structure**

Run: `pnpm test:workspace`

Expected before final alignment: the new ownership assertion fails; after alignment it passes.

- [ ] **Step 3: Run complete verification**

Run:

```powershell
pnpm --filter @loomic/web test
pnpm --filter @loomic/web typecheck
pnpm --filter @loomic/server typecheck
pnpm test:workspace
git diff --check
```

Expected: all return exit 0. Run `pnpm ci:check`; if unrelated existing lint errors remain, record their exact files separately and do not claim the aggregate gate passes.

- [ ] **Step 4: Update governance evidence**

Record exact test counts and the sole live-run owner. Close ENG-038 only if the architecture assertion and all focused/full Web tests pass.

- [ ] **Step 5: Commit**

Commit: `docs(governance): verify agent run ownership`
