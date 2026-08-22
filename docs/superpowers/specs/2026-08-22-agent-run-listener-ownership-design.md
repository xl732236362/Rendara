# Agent Run Listener Ownership Design

Date: 2026-08-22

## 1. Purpose

Move Agent run event listening out of `ChatSidebar` so a chat panel can be
unmounted and remounted without interrupting an Agent run. Each canvas owns
one background run receiver. The receiver survives ChatSidebar remounts and
is replaced only when the canvas owner changes.

This closes the remaining ENG-038 ownership gap from Phase 6A without
changing the chat visual design, Agent protocol, durable message model, or
Canvas persistence behavior.

## 2. Current Problem

`apps/web/src/components/chat-sidebar.tsx` currently owns the per-run listener
map, assistant ID mapping, replay listener, reconnect handling, and cleanup.
The component cleanup therefore controls the lifetime of work that belongs to
an Agent run. A panel remount can remove listeners for a run that is still
active, while reconnect code can recreate listeners in the component with
subtle duplicate-delivery risks.

## 3. Goals and Non-goals

### Goals

- Give each canvas one explicit background Agent run receiver.
- Keep the receiver alive across ChatSidebar unmount/remount within one canvas.
- Release the receiver when the canvas owner changes.
- Preserve current ACK, stream, replay, persistence-fallback, stop, and canvas
  sync behavior.
- Make duplicate delivery and cleanup idempotent.
- Add focused lifecycle, replay, routing, and cleanup tests.
- Add bounded diagnostic logs without logging message content or tokens.

### Non-goals

- No visual redesign of ChatSidebar.
- No move of durable chat history into the receiver.
- No change to the Agent/WebSocket wire protocol.
- No change to Query ownership for persisted chat pages.
- No change to Canvas revision CAS or realtime cursor persistence.
- No global receiver shared by multiple canvases.

## 4. Ownership Model

```text
Canvas page
  |
  +-- Canvas-scoped AgentRunController
        |
        +-- one canvas WebSocket subscription
        +-- run A state
        +-- run B state
        +-- reconnect/replay coordination
        +-- terminal cleanup

ChatSidebar instances
  +-- subscribe to controller
  +-- render state and send commands
  +-- never own run listener cleanup
```

The controller is created by `apps/web/src/app/canvas/page.tsx` for one
`canvasId` and the page's existing `WebSocketHandle`. It remains the same
while that canvas remains active, even if ChatSidebar is temporarily closed or
remounted. On a canvas change, the page disposes the old controller and creates
a new controller; no run state crosses that boundary. The controller owns one
`ws.onEvent` subscription for the canvas, not one WebSocket subscription per
Agent run.

The controller owns only live run coordination:

- active run identity and session association;
- assistant placeholder identity;
- latest normalized live assistant state needed by a remounted sidebar;
- processed event IDs/sequences;
- WebSocket subscriptions and replay cleanup;
- terminal and recovery status.

The controller does not own input drafts, scroll position, menus, durable
message pages, notifications, or Canvas local editing state.

## 5. Proposed Boundary

Create the framework-independent module at:

`apps/web/src/lib/agent-run-controller.ts`

with a factory that receives the existing WebSocket handle and explicit
callbacks for stream application, Canvas sync, persistence fallback, and
diagnostics. The page creates it with a stable `useRef`/canvas identity guard;
ChatSidebar receives the controller instance through an explicit prop. The
public operations are:

```ts
type AgentRunController = {
  startRun(input: {
    runId: string;
    sessionId: string;
    assistantId: string;
  }): void;
  requestResume(): void;
  handleResumeAck(ack: WsCommandAck): void;
  getActiveRuns(): ReadonlyMap<string, ActiveRun>;
  subscribe(listener: () => void): () => void;
  acknowledgeTerminal(runId: string): void;
  disposeRun(runId: string): void;
  dispose(): void;
};

type ActiveRun = {
  runId: string;
  sessionId: string;
  assistantId: string;
  status: "running" | "stopping" | "completed" | "failed" | "canceled";
  contentBlocks: ContentBlock[];
  lastEventId?: string;
  latestBillingError?: Extract<StreamEvent, { type: "billing.error" }>;
  terminalEvent?: Extract<
    StreamEvent,
    { type: "run.completed" | "run.failed" | "run.canceled" }
  >;
};

type ControllerHandlers = {
  onCanvasSync(event: Extract<StreamEvent, { type: "canvas.sync" }>): void;
  onPersistenceFailure(run: ActiveRun): Promise<void> | void;
  onReplayGap(input: { canvasId: string; sessionId?: string }): Promise<void> | void;
  onDiagnostic(input: {
    marker: string;
    runId?: string;
    sessionId?: string;
    eventType?: string;
  }): void;
};
```

`ContentBlock` and `StreamEvent` come from `@loomic/shared`; `WsCommandAck`
comes from the existing WebSocket hook/protocol types. `ActiveRun` is the
smallest state needed to rebuild the temporary assistant item after a sidebar
remount. It is not a replacement for the durable message page.

Extract the switch currently inside `useChatStream` into one pure reducer,
for example `reduceAgentRunContent(previousBlocks, event)`. The controller
uses that reducer to update `ActiveRun.contentBlocks`; ChatSidebar renders the
resulting snapshot and does not maintain a second event-to-message reducer.
The existing behavior for text/thinking deltas, tool start/completion/failure,
run failure fallback text, and cancel cleanup must be preserved exactly and
covered by the existing Chat tests plus focused reducer tests.

The controller installs one `ws.onEvent` callback when created. That callback
routes `canvas.sync` by canvas ID and all run events by run ID plus session ID.
The existing WebSocket hook remains responsible for canvas sequence filtering;
the controller must not invent a second sequence cursor. For events that carry
an event ID, the controller keeps a bounded per-run set of processed IDs to
protect against replay duplicates. The controller must not import React,
routing, QueryClient, or UI notification modules.

`ControllerHandlers` are fixed when the canvas page creates the controller and
must use stable page-owned refs where a current token or callback is required.
ChatSidebar observes snapshots only through `subscribe`; unmounting removes
only that UI subscription. Run routing, accumulated assistant state, terminal
cleanup, and persistence-fallback authorization therefore do not depend on a
stale sidebar closure. The fallback handler receives the controller's run
snapshot and uses the existing stable assistant ID and idempotent save path.

UI-only effects remain outside the controller. Billing dialogs, tier-limit
toasts, preview-model hints, stop-button state, performance display, and
attachment refresh are produced by observing `ActiveRun` snapshots. A billing
or terminal event received while ChatSidebar is absent stays in the snapshot
until a sidebar observes it; the controller does not import or invoke UI code.
Persistence fallback and replay-gap recovery are different: they protect
durable correctness and therefore remain controller handlers that work without
a mounted sidebar.

`ChatSidebar` will subscribe to controller snapshots and call controller
operations. It will retain presentation state and existing message update
callbacks, but its `runListenerByRunIdRef` and listener cleanup effect will be
removed after migration.

## 6. Event and Recovery Flow

### Starting a run

1. ChatSidebar sends the run command and receives the existing ACK.
2. It calls `startRun` with the run ID, session ID, and assistant placeholder ID.
3. The existing canvas subscription routes later events into the controller.
4. The controller routes stream events by run ID and session ID before callbacks
   update the UI or durable-message recovery path.
5. The controller accumulates normalized assistant state so a later
   ChatSidebar can render the current placeholder and continue from the same
   assistant ID.

### Live events

The controller accepts each event once. The WebSocket hook filters canvas
sequence duplicates; the controller filters repeated event IDs when present.
Message text is never used as a duplicate key. Events for a different canvas
or session are ignored and logged with redacted identifiers.

### Reconnect and replay

1. The controller preserves active run state while the socket is disconnected.
2. When the page observes the existing `ws.connected` transition, it calls
   `requestResume`; the controller sends the existing resume request and owns
   the ACK callback even when ChatSidebar is absent.
3. Replay events are routed through the same deduplication path as live events.
4. If the server reports a replay gap, the controller asks the existing chat
   recovery callback to reload the authoritative durable message page.
5. The single canvas subscription remains active for the whole controller
   lifetime. Replay bookkeeping is cleared after the replay window is consumed;
   the final run snapshot follows the terminal acknowledgement and bounded
   retention rules below.

### Terminal events

For `run.completed`, `run.failed`, and `run.canceled`, the controller marks the
run terminal and stops treating it as active, but retains its final snapshot.
ChatSidebar calls `acknowledgeTerminal(runId)` only after the terminal UI has
been observed or the authoritative durable message reload has replaced the
temporary assistant item. That acknowledgement removes the retained snapshot.
`assistant.persistence_failed` invokes the idempotent fallback before terminal
acknowledgement. All cleanup is scoped to one run and idempotent.

To prevent an unmounted sidebar from retaining terminal snapshots forever,
the controller keeps at most 20 terminal snapshots and removes snapshots older
than 30 minutes whenever a run starts, a resume completes, or a terminal state
is acknowledged. These limits affect only temporary UI snapshots; durable
messages remain in the server-owned chat history.

## 7. Error and Lifecycle Rules

- Closing ChatSidebar removes only the sidebar subscription; it does not stop
  an Agent or dispose the canvas controller.
- A stop button sends the existing stop command first. The run changes to
  `stopping`; it becomes terminal only after server confirmation and its final
  snapshot remains until acknowledged or pruned by the bounded retention rule.
- A failed stop request keeps the listener active until a terminal result or
  canvas disposal.
- A canvas change disposes the old controller before creating the new one.
- Page teardown disposes WebSocket subscriptions without marking active runs as
  failed.
- Every disposal path is idempotent and records a redacted diagnostic marker.
- Logs may include canvas ID, session ID, run ID, event type, and counts, but
  never message content, access tokens, cursor values, or provider payloads.

## 8. Testing and Acceptance

Create `apps/web/test/agent-run-controller.test.ts` and preserve existing
ChatSidebar tests. The focused suite must cover:

- active run survives sidebar unsubscribe/resubscribe;
- controller installs exactly one `ws.onEvent` subscription per canvas;
- creating and disposing a controller removes that one subscription exactly once;
- remounting replaces rendering callbacks without losing accumulated run state;
- a persistence-failure event still uses controller-owned assistant state when
  no ChatSidebar is mounted;
- text, thinking, tool, failure, and cancellation events use one shared pure
  reducer with behavior identical to the current `useChatStream` rules;
- billing and terminal UI state received while the sidebar is absent is visible
  after remount without reprocessing the event;
- only the matching run receives an event;
- different sessions and canvases are ignored;
- duplicate live/replay events are applied once;
- reconnect replays only the missing event window;
- replay gaps trigger authoritative message reload;
- terminal events stop only their own active run and retain only that run's
  bounded final snapshot;
- terminal acknowledgement and age/count pruning remove final snapshots
  without touching active runs;
- stop waits for server confirmation;
- repeated `disposeRun` and `dispose` do not double-unsubscribe;
- canvas disposal prevents later events from reaching the new canvas;
- persistence fallback remains single-shot;
- existing user-message, assistant-message, canvas-sync, and recovery tests
  remain green.

Acceptance requires:

- no per-run WebSocket listener ownership remains in ChatSidebar;
- one controller exists per active canvas;
- same-canvas remount preserves active runs;
- canvas change isolates and disposes old runs;
- Web and Server typechecks pass;
- the focused Web tests and full Web test suite pass;
- the resource ownership inventory records the controller as the sole live
  Agent run owner;
- ENG-038 is updated only after the above evidence is recorded.

## 9. Rollback

If the controller migration causes a recovery regression, restore the previous
ChatSidebar listener implementation in one release while leaving the existing
Agent protocol and durable message persistence unchanged. Do not disable
server-side run recovery or remove replay cursors as part of this rollback.

## 10. Implementation Notes

The migration should be incremental: first extract behavior without changing
event semantics, then switch ChatSidebar to the controller, then remove the
old listener map and cleanup effect. Each step needs a focused failing test
before production code changes. Add a short follow-up note to the Phase 6A
verification record after the final full-suite run.
