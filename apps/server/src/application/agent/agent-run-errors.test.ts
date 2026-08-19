import { describe, expect, it, vi } from "vitest";

import { runWithDeadline } from "./agent-run-errors.js";

describe("runWithDeadline", () => {
  it("rejects and aborts a dependency that ignores cancellation", async () => {
    vi.useFakeTimers();
    const timeoutError = new Error("deadline reached");
    let observedSignal: AbortSignal | undefined;
    const result = runWithDeadline({
      operation: (signal) => {
        observedSignal = signal;
        return new Promise<never>(() => undefined);
      },
      timeoutError: () => timeoutError,
      timeoutMs: 25,
    });
    const rejection = expect(result).rejects.toBe(timeoutError);

    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(observedSignal?.aborted).toBe(true);
    expect(observedSignal?.reason).toBe(timeoutError);
    vi.useRealTimers();
  });

  it("clears its timer after a dependency settles", async () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

    await expect(
      runWithDeadline({
        operation: async () => "done",
        timeoutError: () => new Error("too late"),
        timeoutMs: 25,
      }),
    ).resolves.toBe("done");

    expect(clearTimeoutSpy).toHaveBeenCalledOnce();
    clearTimeoutSpy.mockRestore();
    vi.useRealTimers();
  });
});
