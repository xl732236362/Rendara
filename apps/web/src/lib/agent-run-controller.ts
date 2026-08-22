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
  onDiagnostic?: (input: {
    marker: string;
    canvasId: string;
    runId?: string;
    sessionId?: string;
    eventType?: StreamEvent["type"];
    runCount?: number;
  }) => void;
};

export function createAgentRunController(options: ControllerOptions) {
  const now = options.now ?? Date.now;
  const runs = new Map<string, ActiveRun>();
  const subscribers = new Set<() => void>();
  const terminalWaiters = new Map<
    string,
    Set<(run: ActiveRun | undefined) => void>
  >();
  const fallbackStarted = new Set<string>();
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
      if (event.canvasId === options.canvasId) {
        options.onCanvasSync?.(event);
      } else {
        options.onDiagnostic?.({
          marker: "canvas_event_mismatch",
          canvasId: options.canvasId,
          eventType: event.type,
        });
      }
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
        void options.onRecoveredPersistenceFailure?.(event);
      } else {
        options.onDiagnostic?.({
          marker: "unknown_run_event_ignored",
          canvasId: options.canvasId,
          runId: event.runId,
          eventType: event.type,
        });
      }
      return;
    }
    if (
      "sessionId" in event &&
      typeof event.sessionId === "string" &&
      event.sessionId !== run.sessionId
    ) {
      options.onDiagnostic?.({
        marker: "run_event_session_mismatch",
        canvasId: options.canvasId,
        runId: run.runId,
        sessionId: event.sessionId,
        eventType: event.type,
      });
      return;
    }
    if (
      "conversationId" in event &&
      typeof event.conversationId === "string" &&
      event.conversationId !== options.canvasId
    ) {
      options.onDiagnostic?.({
        marker: "run_event_canvas_mismatch",
        canvasId: options.canvasId,
        runId: run.runId,
        sessionId: run.sessionId,
        eventType: event.type,
      });
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
      const waiters = terminalWaiters.get(run.runId);
      terminalWaiters.delete(run.runId);
      for (const resolve of waiters ?? []) resolve(next);
    }
    runs.set(run.runId, next);

    if (
      event.type === "assistant.persistence_failed" &&
      !fallbackStarted.has(run.runId)
    ) {
      fallbackStarted.add(run.runId);
      void options.onPersistenceFailure?.(next);
    }
    prune();
    notify();
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
    markStopping(runId: string) {
      const run = runs.get(runId);
      if (!run || run.status !== "running") return;
      runs.set(runId, { ...run, status: "stopping" });
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
    waitForTerminal(runId: string): Promise<ActiveRun | undefined> {
      const run = runs.get(runId);
      if (!run || run.terminalAt !== undefined) return Promise.resolve(run);
      return new Promise((resolve) => {
        const waiters = terminalWaiters.get(runId) ?? new Set();
        waiters.add(resolve);
        terminalWaiters.set(runId, waiters);
      });
    },
    requestResume() {
      options.ws.resumeCanvas?.(options.canvasId, (ack) => {
        prune();
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
        const localRun = activeRunId ? runs.get(activeRunId) : undefined;
        const sessionMismatch = Boolean(
          localRun && sessionId && localRun.sessionId !== sessionId,
        );
        if (sessionMismatch && localRun && sessionId) {
          options.onDiagnostic?.({
            marker: "resume_session_mismatch",
            canvasId: options.canvasId,
            runId: localRun.runId,
            sessionId,
          });
          for (const resolve of terminalWaiters.get(localRun.runId) ?? [])
            resolve(undefined);
          terminalWaiters.delete(localRun.runId);
          fallbackStarted.delete(localRun.runId);
          runs.set(localRun.runId, {
            runId: localRun.runId,
            sessionId,
            assistantId: `resumed_${localRun.runId}`,
            status: "running",
            contentBlocks: [],
          });
          options.onReplayGap?.({ canvasId: options.canvasId, sessionId });
          notify();
        } else if (activeRunId && sessionId && !localRun) {
          runs.set(activeRunId, {
            runId: activeRunId,
            sessionId,
            assistantId: `resumed_${activeRunId}`,
            status: "running",
            contentBlocks: [],
          });
          notify();
        }
        if (replayGap && !sessionMismatch) {
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
        prune();
        notify();
      }
    },
    disposeRun(runId: string) {
      const run = runs.get(runId);
      for (const resolve of terminalWaiters.get(runId) ?? [])
        resolve(undefined);
      terminalWaiters.delete(runId);
      if (run && runs.delete(runId)) {
        options.onDiagnostic?.({
          marker: "run_disposed",
          canvasId: options.canvasId,
          runId: run.runId,
          sessionId: run.sessionId,
        });
        notify();
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      options.onDiagnostic?.({
        marker: "controller_disposed",
        canvasId: options.canvasId,
        runCount: runs.size,
      });
      unsubscribeSocket();
      subscribers.clear();
      for (const waiters of terminalWaiters.values()) {
        for (const resolve of waiters) resolve(undefined);
      }
      terminalWaiters.clear();
      runs.clear();
    },
  };
}

export type AgentRunController = ReturnType<typeof createAgentRunController>;
