import { describe, expect, it, vi } from "vitest";
import { createRealtimeRetentionCleanup } from "./realtime-retention.js";

describe("realtime event retention cleanup", () => {
  it("prunes old events while retaining a per-canvas replay window", async () => {
    const prune = vi.fn(async () => 12);
    const cleanup = createRealtimeRetentionCleanup({
      now: () => new Date("2026-08-21T00:00:00.000Z"),
      prune,
    });

    await expect(cleanup.runOnce()).resolves.toBe(12);
    expect(prune).toHaveBeenCalledWith({
      before: new Date("2026-08-14T00:00:00.000Z"),
      keepPerCanvas: 5_000,
    });
  });

  it("stops its unreferenced daily schedule", () => {
    const unref = vi.fn();
    const timer = { unref } as unknown as NodeJS.Timeout;
    const setIntervalSpy = vi
      .spyOn(globalThis, "setInterval")
      .mockReturnValue(timer);
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const cleanup = createRealtimeRetentionCleanup({
      prune: vi.fn(async () => 0),
    });

    cleanup.start();
    cleanup.stop();

    expect(setIntervalSpy).toHaveBeenCalledWith(
      expect.any(Function),
      86_400_000,
    );
    expect(unref).toHaveBeenCalledOnce();
    expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });
});
