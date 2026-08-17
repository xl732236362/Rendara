import { describe, expect, it } from "vitest";

import { WsCommandBudget } from "./ws-command-budget.js";

describe("WsCommandBudget", () => {
  it("rejects messages larger than 1 MB", () => {
    const budget = new WsCommandBudget();

    expect(() => budget.consumeMessage(1024 * 1024 + 1)).toThrowError(
      expect.objectContaining({ code: "message_too_large" }),
    );
  });

  it("rejects more than 60 commands in one minute", () => {
    const budget = new WsCommandBudget({ now: () => 1_000 });
    for (let index = 0; index < 60; index += 1) {
      budget.consumeMessage(1);
    }

    expect(() => budget.consumeMessage(1)).toThrowError(
      expect.objectContaining({ code: "rate_limited" }),
    );
  });

  it("allows only one concurrent agent run", () => {
    const budget = new WsCommandBudget();
    budget.startAgentRun();

    expect(() => budget.startAgentRun()).toThrowError(
      expect.objectContaining({ code: "concurrency_limit" }),
    );

    budget.finishAgentRun();
    expect(() => budget.startAgentRun()).not.toThrow();
  });
});
