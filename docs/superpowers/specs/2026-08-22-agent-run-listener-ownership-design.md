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
        +-- run A listener and state
        +-- run B listener and state
        +-- reconnect/replay coordination
        +-- terminal cleanup

ChatSidebar instances
  +-- subscribe to controller
  +-- render state and send commands
  +-- never own run listener cleanup
```

The controller is created for one `canvasId` and one authenticated WebSocket
owner. It remains the same while that canvas remains active, even if
ChatSidebar is temporarily closed or remounted. On a canvas change, the old
controller is disposed and a new controller is created; no run state crosses
that boundary.

The controller owns only live run coordination:

- active run identity and session association;
- assistant placeholder identity;
- processed event IDs/sequences;
- WebSocket subscriptions and replay cleanup;
- terminal and recovery status.

The controller does not own input drafts, scroll position, menus, durable
message pages, notifications, or Canvas local editing state.

## 5. Proposed Boundary

Create a framework-independent module, for example:

`apps/web/src/lib/agent-run-controller.ts`

with a factory that receives the existing WebSocket handle and explicit
callbacks for stream application, Canvas sync, persistence fallback, and
diagnostics. The public operations are:

```ts
type AgentRunController = {
  startRun(input: {
    runId: string;
    sessionId: string;
    assistantId: string;
  }): void;
  handleResume(ack: ResumeAck): void;
  handleEvent(event: StreamEvent): void;
  getActiveRuns(): ReadonlyMap<string, ActiveRun>;
  subscribe(listener: () => void): () => void;
  disposeRun(runId: string): void;
  dispose(): void;
};
```

The exact callback types should reuse existing shared WebSocket and stream
types. The controller must not import React, routing, QueryClient, or UI
notification modules.

`ChatSidebar` will subscribe to controller snapshots and call controller
operations. It will retain presentation state and existing message update
callbacks, but its `runListenerByRunIdRef` and listener cleanup effect will be
removed after migration.

## 6. Event and Recovery Flow

### Starting a run

1. ChatSidebar sends the run command and receives the existing ACK.
2. It calls `startRun` with the run ID, session ID, and assistant placeholder ID.
3. The controller registers exactly one listener for that run.
4. Incoming stream events are routed by run ID and session ID before callbacks
   update the UI or durable-message recovery path.

### Live events

The controller accepts each event once. Event identity/sequence is used for
deduplication; message text is never used as a duplicate key. Events for a
different canvas or session are ignored and logged with redacted identifiers.

### Reconnect and replay

1. The controller preserves active run state while the socket is disconnected.
2. After reconnect, it sends the existing resume request.
3. Replay events are routed through the same deduplication path as live events.
4. If the server reports a replay gap, the controller asks the existing chat
   recovery callback to reload the authoritative durable message page.
5. A replay listener is cleaned only after its expected replay window is
   consumed, or after an explicit terminal/dispose action.

### Terminal events

For completed, failed, cancelled, and persistence-failure terminal states, the
controller publishes the terminal status, invokes the existing fallback or
reload callback where required, and then cleans only that run's listener.
Cleanup is idempotent and safe to call more than once.

## 7. Error and Lifecycle Rules

- Closing ChatSidebar removes only the sidebar subscription; it does not stop
  an Agent or dispose the canvas controller.
- A stop button sends the existing stop command first. The run is disposed only
  after the server confirms a terminal state.
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
- only the matching run receives an event;
- different sessions and canvases are ignored;
- duplicate live/replay events are applied once;
- reconnect replays only the missing event window;
- replay gaps trigger authoritative message reload;
- terminal events clean only their own run;
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
