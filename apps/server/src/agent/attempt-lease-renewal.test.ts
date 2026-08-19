import { describe, expect, it, vi } from "vitest";

import { startAttemptLeaseRenewal } from "./runtime.js";

describe("attempt lease renewal", () => {
  it("renews every 15 seconds with the same owner, fence, and 60 second lease", async () => {
    vi.useFakeTimers();
    try {
      const renewAttempt = vi.fn(async () => ({
        leaseExpiresAt: new Date("2026-08-20T00:01:15.000Z"),
      }));
      const controller = startAttemptLeaseRenewal({
        repository: { renewAttempt } as never,
        attemptId: "attempt-1",
        fencingToken: 7,
        leaseOwner: "runtime-1",
        leaseMs: 60_000,
        renewEveryMs: 15_000,
        now: () => new Date("2026-08-20T00:00:15.000Z"),
        onFenceInvalid: vi.fn(),
      });

      await vi.advanceTimersByTimeAsync(45_001);
      expect(renewAttempt).toHaveBeenCalledTimes(3);
      expect(renewAttempt).toHaveBeenNthCalledWith(1, {
        attemptId: "attempt-1",
        fencingToken: 7,
        leaseOwner: "runtime-1",
        leaseMs: 60_000,
        now: new Date("2026-08-20T00:00:15.000Z"),
      });
      expect(controller.isValid()).toBe(true);
      await controller.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalidates the fence once on renewal failure and stops future renewal", async () => {
    vi.useFakeTimers();
    try {
      const renewAttempt = vi.fn(async () => {
        throw new Error("run_not_active");
      });
      const onFenceInvalid = vi.fn();
      const controller = startAttemptLeaseRenewal({
        repository: { renewAttempt } as never,
        attemptId: "attempt-1",
        fencingToken: 7,
        leaseOwner: "runtime-1",
        leaseMs: 60_000,
        renewEveryMs: 15_000,
        now: () => new Date(),
        onFenceInvalid,
      });

      await vi.advanceTimersByTimeAsync(60_000);
      expect(controller.isValid()).toBe(false);
      expect(renewAttempt).toHaveBeenCalledOnce();
      expect(onFenceInvalid).toHaveBeenCalledOnce();
      await controller.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
