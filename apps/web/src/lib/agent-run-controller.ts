import type { ContentBlock, StreamEvent } from "@loomic/shared";

import { reduceAgentRunContent } from "./agent-run-content";

type RunStatus = "running" | "stopping" | "completed" | "failed" | "canceled";

export type ActiveRun = {
  runId: string;
  sessionId: string;
  assistantId: string;
  status: RunStatus;
  contentBlocks: ContentBlock[];
  terminalAt?: number;
  latestBillingError?: Extract<StreamEvent, { type: "billing.error" }>;
  terminalEvent?: Extract<
    StreamEvent,
    { type: "run.completed" | "run.failed" | "run.canceled" }
  >;
};

type RunSocket = {
  onEvent(listener: (event: StreamEvent) => void): () => void;
  resumeCanvas?(canvasId: string, onAck?: (ack: unknown) => void): void;
};

type ControllerOptions = {
  canvasId: string;
  ws: RunSocket;
  now?: () => number;
  onCanvasSync?: (event: Extract<StreamEvent, { type: "canvas.sync" }>) => void;
  onPersistenceFailure?: (run: ActiveRun) => Promise<void> | void;
  onRecoveredPersistenceFailure?: (
    event: Extract<StreamEvent, { type: "assistant.persistence_failed" }>,
  ) => Promise<void> | void;
  onReplayGap?: (input: { canvasId: string; sessionId?: string }) => void;
  onRunEvent?: (event: StreamEvent) => void;
};

export function createAgentRunController(options: ControllerOptions) {
  const now = options.now ?? Date.now;
  const runs = new Map<string, ActiveRun>();
  const subscribers = new Set<() => void>();
  const eventSubscribers = new Set<(event: StreamEvent) => void>();
  const fallbackStarted = new Set<string>();
  let persistenceFailureHandler = options.onPersistenceFailure;
  let recoveredPersistenceFailureHandler =
    options.onRecoveredPersistenceFailure;
  let disposed = false;

  const notify = () => {
    for (const subscriber of subscribers) subscriber();
  };

  const prune = () => {
    const cutoff = now() - 30 * 60 * 1000;
    const terminal = [...runs.values()]
      .filter((run) => run.terminalAt !== undefined)
      .sort((left, right) => (left.terminalAt ?? 0) - (right.terminalAt ?? 0));
    for (const run of terminal) {
      if ((run.terminalAt ?? 0) < cutoff) runs.delete(run.runId);
    }
    const retained = terminal.filter((run) => runs.has(run.runId));
    for (const run of retained.slice(0, Math.max(0, retained.length - 20))) {
      runs.delete(run.runId);
    }
  };

  const handleEvent = (event: StreamEvent) => {
    if (disposed) return;
    if (event.type === "canvas.sync") {
      if (event.canvasId === options.canvasId) options.onCanvasSync?.(event);
      return;
    }
    if (!("runId" in event) || typeof event.runId !== "string") return;
    const run = runs.get(event.runId);
    if (!run) {
      if (
        event.type === "assistant.persistence_failed" &&
        event.assistant &&
        !fallbackStarted.has(event.runId)
      ) {
        fallbackStarted.add(event.runId);
        void recoveredPersistenceFailureHandler?.(event);
      }
      return;
    }
    options.onRunEvent?.(event);

    const next: ActiveRun = {
      ...run,
      contentBlocks: reduceAgentRunContent(run.contentBlocks, event),
    };
    if (event.type === "billing.error") next.latestBillingError = event;
    if (
      event.type === "run.completed" ||
      event.type === "run.failed" ||
      event.type === "run.canceled"
    ) {
      next.status = event.type.slice(4) as RunStatus;
      next.terminalEvent = event;
      next.terminalAt = now();
    }
    runs.set(run.runId, next);

    if (
      event.type === "assistant.persistence_failed" &&
      !fallbackStarted.has(run.runId)
    ) {
      fallbackStarted.add(run.runId);
      void persistenceFailureHandler?.(next);
    }
    prune();
    notify();
    for (const subscriber of eventSubscribers) subscriber(event);
  };

  const unsubscribeSocket = options.ws.onEvent(handleEvent);

  return {
    startRun(input: {
      runId: string;
      sessionId: string;
      assistantId: string;
    }) {
      if (disposed) return;
      prune();
      runs.set(input.runId, {
        ...input,
        status: "running",
        contentBlocks: [],
      });
      notify();
    },
    getRuns(): ReadonlyMap<string, ActiveRun> {
      return runs;
    },
    subscribe(subscriber: () => void) {
      subscribers.add(subscriber);
      subscriber();
      return () => {
        subscribers.delete(subscriber);
      };
    },
    onEvent(subscriber: (event: StreamEvent) => void) {
      eventSubscribers.add(subscriber);
      return () => {
        eventSubscribers.delete(subscriber);
      };
    },
    setPersistenceHandlers(handlers: {
      onPersistenceFailure?: (run: ActiveRun) => Promise<void> | void;
      onRecoveredPersistenceFailure?: (
        event: Extract<StreamEvent, { type: "assistant.persistence_failed" }>,
      ) => Promise<void> | void;
    }) {
      persistenceFailureHandler = handlers.onPersistenceFailure;
      recoveredPersistenceFailureHandler =
        handlers.onRecoveredPersistenceFailure;
    },
    requestResume() {
      options.ws.resumeCanvas?.(options.canvasId, (ack) => {
        if (!ack || typeof ack !== "object" || !("payload" in ack)) return;
        const payload = ack.payload;
        if (!payload || typeof payload !== "object") return;
        const replayGap = "replayGap" in payload && payload.replayGap === true;
        const sessionId =
          "activeRunSessionId" in payload &&
          typeof payload.activeRunSessionId === "string"
            ? payload.activeRunSessionId
            : undefined;
        const activeRunId =
          "activeRunId" in payload && typeof payload.activeRunId === "string"
            ? payload.activeRunId
            : undefined;
        if (activeRunId && sessionId && !runs.has(activeRunId)) {
          runs.set(activeRunId, {
            runId: activeRunId,
            sessionId,
            assistantId: `resumed_${activeRunId}`,
            status: "running",
            contentBlocks: [],
          });
          notify();
        }
        if (replayGap) {
          options.onReplayGap?.({
            canvasId: options.canvasId,
            ...(sessionId ? { sessionId } : {}),
          });
        }
      });
    },
    acknowledgeTerminal(runId: string) {
      const run = runs.get(runId);
      if (run?.terminalAt !== undefined) {
        runs.delete(runId);
        notify();
      }
    },
    disposeRun(runId: string) {
      if (runs.delete(runId)) notify();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeSocket();
      subscribers.clear();
      eventSubscribers.clear();
      runs.clear();
    },
  };
}

export type AgentRunController = ReturnType<typeof createAgentRunController>;
