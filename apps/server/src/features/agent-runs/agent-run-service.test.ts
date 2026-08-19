import { describe, expect, it, vi } from "vitest";

import {
  AgentFinalizationUnconfirmedError,
  createAgentRunMetadataService,
  finalizeAgentRun,
} from "./agent-run-service.js";

describe("Agent run metadata persistence", () => {
  it("retries a transient metadata update before failing the run", async () => {
    const eq = vi
      .fn()
      .mockResolvedValueOnce({
        error: {
          code: "PGRST000",
          message: "transient connection failure",
        },
      })
      .mockResolvedValueOnce({ error: null });
    const service = createAgentRunMetadataService({
      getAdminClient: () =>
        ({
          from: () => ({
            update: () => ({ eq }),
          }),
        }) as never,
      retryDelayMs: 0,
    });

    await expect(
      service.updateRun({ runId: "run-1", status: "completed" }),
    ).resolves.toBeUndefined();
    expect(eq).toHaveBeenCalledTimes(2);
  });

  it("bounds retries when metadata storage remains unavailable", async () => {
    const eq = vi.fn().mockResolvedValue({
      error: { code: "PGRST000", message: "connection unavailable" },
    });
    const service = createAgentRunMetadataService({
      getAdminClient: () =>
        ({
          from: () => ({
            update: () => ({ eq }),
          }),
        }) as never,
      retryDelayMs: 0,
    });

    await expect(
      service.updateRun({ runId: "run-1", status: "completed" }),
    ).rejects.toThrow("Failed to update run metadata.");
    expect(eq).toHaveBeenCalledTimes(3);
  });
});

describe("Agent run finalization", () => {
  const input = {
    attemptId: "attempt-1",
    fencingToken: 2,
    metadata: {},
    runId: "run-1",
    status: "completed" as const,
  };

  it("retries the same idempotent finalization until persistence confirms it", async () => {
    const confirmed = {
      completedAt: new Date("2026-08-19T00:00:03.000Z"),
      status: "completed" as const,
    };
    const finalizeRun = vi
      .fn()
      .mockRejectedValueOnce(new Error("agent_execution_persistence_failed"))
      .mockResolvedValueOnce(confirmed);

    await expect(
      finalizeAgentRun({
        repository: { finalizeRun } as never,
        input,
        retryDelayMs: 0,
        correlationId: "corr-1",
      }),
    ).resolves.toEqual(confirmed);
    expect(finalizeRun).toHaveBeenCalledTimes(2);
    expect(finalizeRun).toHaveBeenNthCalledWith(1, input);
    expect(finalizeRun).toHaveBeenNthCalledWith(2, input);
  });

  it("reports an unconfirmed result after bounded retries", async () => {
    const finalizeRun = vi
      .fn()
      .mockRejectedValue(new Error("agent_execution_persistence_failed"));

    const error = await finalizeAgentRun({
      repository: { finalizeRun } as never,
      input,
      retryDelayMs: 0,
      correlationId: "corr-1",
    }).catch((cause) => cause);

    expect(error).toBeInstanceOf(AgentFinalizationUnconfirmedError);
    expect(error).toMatchObject({
      code: "run_finalization_unconfirmed",
      correlationId: "corr-1",
    });
    expect(finalizeRun).toHaveBeenCalledTimes(3);
  });
});
