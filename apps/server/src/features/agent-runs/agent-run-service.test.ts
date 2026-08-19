import { describe, expect, it, vi } from "vitest";

import { createAgentRunMetadataService } from "./agent-run-service.js";

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
