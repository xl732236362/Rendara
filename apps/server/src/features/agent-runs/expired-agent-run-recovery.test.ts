import { describe, expect, it, vi } from "vitest";

import { createExpiredAgentRunRecovery } from "./expired-agent-run-recovery.js";

describe("expired Agent run recovery", () => {
  it("scans immediately and every five seconds with bounded recovery inputs", async () => {
    vi.useFakeTimers();
    try {
      const recoverExpiredRuns = vi.fn(async () => []);
      const recovery = createExpiredAgentRunRecovery({
        repository: { recoverExpiredRuns },
        now: () => new Date("2026-08-20T00:00:00.000Z"),
      });

      await recovery.start();
      expect(recoverExpiredRuns).toHaveBeenCalledWith({
        graceMs: 30_000,
        limit: 25,
        now: new Date("2026-08-20T00:00:00.000Z"),
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(recoverExpiredRuns).toHaveBeenCalledTimes(2);
      await recovery.stop();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(recoverExpiredRuns).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs identifiers only and continues after a failed scan", async () => {
    vi.useFakeTimers();
    try {
      const recoverExpiredRuns = vi
        .fn()
        .mockRejectedValueOnce(new Error("database secret"))
        .mockResolvedValueOnce([
          {
            runId: "11111111-1111-4111-8111-111111111111",
            attemptId: "22222222-2222-4222-8222-222222222222",
            status: "failed",
          },
        ]);
      const logger = { info: vi.fn(), error: vi.fn() };
      const recovery = createExpiredAgentRunRecovery({
        repository: { recoverExpiredRuns },
        logger,
      });

      await recovery.start();
      expect(logger.error).toHaveBeenCalledWith(
        "agent.run.expired_recovery_failed",
        { errorCode: "expired_run_recovery_failed" },
      );
      await vi.advanceTimersByTimeAsync(5_000);
      expect(logger.info).toHaveBeenCalledWith("agent.run.expired_recovered", {
        attemptId: "22222222-2222-4222-8222-222222222222",
        runId: "11111111-1111-4111-8111-111111111111",
      });
      await recovery.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
