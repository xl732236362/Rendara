import { AgentRunError } from "../application/agent/agent-run-errors.js";

type DeadlineKind = "model" | "overall" | "tool";

type RunDeadlineGuardOptions = {
  modelInactivityMs: number;
  toolDeadlineMs: number;
  overallDeadlineMs: number;
  abort(): void;
  closeIterator(): Promise<void>;
  now?: () => number;
};

export function createRunDeadlineGuard(options: RunDeadlineGuardOptions) {
  assertDuration(options.modelInactivityMs);
  assertDuration(options.toolDeadlineMs);
  assertDuration(options.overallDeadlineMs);
  const now = options.now ?? Date.now;
  const openTools = new Map<string, number>();
  let modelTimer: ReturnType<typeof setTimeout> | undefined;
  let toolTimer: ReturnType<typeof setTimeout> | undefined;
  let overallTimer: ReturnType<typeof setTimeout> | undefined;
  let terminal = false;
  let rejectDeadline: (error: AgentRunError) => void = () => {};
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  // A deadline can fire between iterator operations before the consumer races
  // `wait()`. Mark the promise observed without changing its rejected state.
  void deadline.catch(() => undefined);

  const schedule = (
    kind: DeadlineKind,
    durationMs: number,
    callback: () => void,
  ) => {
    const timer = setTimeout(callback, durationMs);
    timer.unref?.();
    if (kind === "model") modelTimer = timer;
    if (kind === "tool") toolTimer = timer;
    if (kind === "overall") overallTimer = timer;
  };

  const clearModelTimer = () => {
    if (modelTimer) clearTimeout(modelTimer);
    modelTimer = undefined;
  };
  const clearToolTimer = () => {
    if (toolTimer) clearTimeout(toolTimer);
    toolTimer = undefined;
  };
  const clearAll = () => {
    clearModelTimer();
    clearToolTimer();
    if (overallTimer) clearTimeout(overallTimer);
    overallTimer = undefined;
  };

  const terminate = (kind: DeadlineKind) => {
    if (terminal) return;
    terminal = true;
    clearAll();
    options.abort();
    rejectDeadline(deadlineError(kind));
    // Iterator cleanup is best-effort after abort. Some provider iterators do
    // not resolve return() until their blocked request observes the signal.
    void options.closeIterator().catch(() => undefined);
  };

  const scheduleModel = () => {
    clearModelTimer();
    if (terminal || openTools.size > 0) return;
    schedule("model", options.modelInactivityMs, () => terminate("model"));
  };

  const scheduleTool = () => {
    clearToolTimer();
    if (terminal || openTools.size === 0) return;
    const oldestStartedAt = Math.min(...openTools.values());
    const remaining = Math.max(
      0,
      options.toolDeadlineMs - (now() - oldestStartedAt),
    );
    schedule("tool", remaining, () => terminate("tool"));
  };

  schedule("overall", options.overallDeadlineMs, () => terminate("overall"));
  scheduleModel();

  return {
    onModelActivity() {
      scheduleModel();
    },
    onToolStarted(toolCallId: string) {
      if (terminal || openTools.has(toolCallId)) return;
      openTools.set(toolCallId, now());
      clearModelTimer();
      scheduleTool();
    },
    onToolFinished(toolCallId: string) {
      if (terminal) return;
      openTools.delete(toolCallId);
      scheduleTool();
      if (openTools.size === 0) scheduleModel();
    },
    state() {
      return {
        phase: openTools.size > 0 ? ("tool" as const) : ("model" as const),
        terminal,
        openToolCallIds: [...openTools.keys()],
      };
    },
    wait() {
      return deadline;
    },
    stop() {
      if (terminal) return;
      terminal = true;
      clearAll();
    },
  };
}

function deadlineError(kind: DeadlineKind): AgentRunError {
  const definitions = {
    model: {
      code: "agent_model_inactivity_timeout" as const,
      message: "Agent model became inactive.",
    },
    tool: {
      code: "agent_tool_deadline_exceeded" as const,
      message: "Agent tool exceeded its deadline.",
    },
    overall: {
      code: "agent_overall_deadline_exceeded" as const,
      message: "Agent run exceeded its overall deadline.",
    },
  };
  return new AgentRunError({
    ...definitions[kind],
    retryable: true,
    statusCode: 504,
  });
}

function assertDuration(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError("Run deadline durations must be positive and finite.");
  }
}
