export class WsBudgetError extends Error {
  constructor(
    readonly code: "message_too_large" | "rate_limited" | "concurrency_limit",
    message: string,
  ) {
    super(message);
  }
}

export class WsCommandBudget {
  private readonly now: () => number;
  private windowStartedAt: number;
  private commandCount = 0;
  private agentRunActive = false;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    this.windowStartedAt = this.now();
  }

  consumeMessage(byteLength: number): void {
    if (byteLength > 1024 * 1024) {
      throw new WsBudgetError(
        "message_too_large",
        "WebSocket messages cannot exceed 1 MB.",
      );
    }

    const currentTime = this.now();
    if (currentTime - this.windowStartedAt >= 60_000) {
      this.windowStartedAt = currentTime;
      this.commandCount = 0;
    }

    this.commandCount += 1;
    if (this.commandCount > 60) {
      throw new WsBudgetError(
        "rate_limited",
        "WebSocket command rate limit exceeded.",
      );
    }
  }

  startAgentRun(): void {
    if (this.agentRunActive) {
      throw new WsBudgetError(
        "concurrency_limit",
        "Only one agent run may be active per connection.",
      );
    }
    this.agentRunActive = true;
  }

  finishAgentRun(): void {
    this.agentRunActive = false;
  }
}
