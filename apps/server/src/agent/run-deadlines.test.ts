import { describe, expect, it, vi } from "vitest";

import { createRunDeadlineGuard } from "./run-deadlines.js";

describe("run deadline guard", () => {
  it("fails a silent model after activity becomes idle", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      harness.guard.onModelActivity();
      await vi.advanceTimersByTimeAsync(29_999);
      expect(harness.guard.state()).toMatchObject({ terminal: false });
      await vi.advanceTimersByTimeAsync(2);

      await expect(harness.guard.wait()).rejects.toMatchObject({
        code: "agent_model_inactivity_timeout",
      });
      expect(harness.abort).toHaveBeenCalledOnce();
      expect(harness.closeIterator).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("pauses model inactivity while a tool is open and uses its deadline", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      harness.guard.onToolStarted("tool-1");
      await vi.advanceTimersByTimeAsync(30_001);
      expect(harness.guard.state()).toMatchObject({
        phase: "tool",
        terminal: false,
      });
      await vi.advanceTimersByTimeAsync(9 * 60_000 + 30_000);
      await expect(harness.guard.wait()).rejects.toMatchObject({
        code: "agent_tool_deadline_exceeded",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("resumes a fresh model inactivity window when the final tool closes", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      harness.guard.onToolStarted("tool-1");
      await vi.advanceTimersByTimeAsync(60_000);
      harness.guard.onToolFinished("tool-1");
      await vi.advanceTimersByTimeAsync(30_001);
      await expect(harness.guard.wait()).rejects.toMatchObject({
        code: "agent_model_inactivity_timeout",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets the overall deadline win and closes the iterator exactly once", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({
        modelInactivityMs: 20 * 60_000,
        toolDeadlineMs: 20 * 60_000,
        overallDeadlineMs: 15 * 60_000,
      });
      harness.guard.onToolStarted("tool-1");
      await vi.advanceTimersByTimeAsync(15 * 60_000 + 1);
      await expect(harness.guard.wait()).rejects.toMatchObject({
        code: "agent_overall_deadline_exceeded",
      });
      harness.guard.stop();
      harness.guard.stop();
      expect(harness.abort).toHaveBeenCalledOnce();
      expect(harness.closeIterator).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

function createHarness(
  overrides: Partial<{
    modelInactivityMs: number;
    toolDeadlineMs: number;
    overallDeadlineMs: number;
  }> = {},
) {
  const abort = vi.fn();
  const closeIterator = vi.fn(async () => undefined);
  const guard = createRunDeadlineGuard({
    modelInactivityMs: overrides.modelInactivityMs ?? 30_000,
    toolDeadlineMs: overrides.toolDeadlineMs ?? 10 * 60_000,
    overallDeadlineMs: overrides.overallDeadlineMs ?? 15 * 60_000,
    abort,
    closeIterator,
  });
  return { abort, closeIterator, guard };
}
