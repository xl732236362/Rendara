import { describe, expect, it, vi } from "vitest";

import { AppError } from "../../errors/app-error.js";
import { createCancelGeneration } from "./cancel-generation.js";
import type {
  GenerationCancellationPort,
  GenerationPrincipal,
  StructuredLogger,
} from "./ports.js";

const principal: GenerationPrincipal = {
  userId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "55555555-5555-4555-8555-555555555555",
};
const jobId = "44444444-4444-4444-8444-444444444444";
const otherJobId = "66666666-6666-4666-8666-666666666666";

describe("CancelGeneration", () => {
  it("privately rejects a cancellation outcome for a different job without success logging", async () => {
    const logger = silentLogger();
    const jobs: GenerationCancellationPort = {
      cancel: vi.fn(async () => ({
        id: otherJobId,
        status: "canceled" as const,
      })),
    };
    const cancel = createCancelGeneration({ jobs, logger });

    await expect(cancel(principal, { jobId })).rejects.toMatchObject({
      code: "application_error",
      statusCode: 500,
      expose: false,
    });
    expect(logger.info).not.toHaveBeenCalled();
  });

  it.each([
    [{ id: jobId, status: "succeeded" }, "succeeded"],
    [{ id: jobId, status: "failed" }, "failed"],
    [{ id: jobId, status: "dead_letter" }, "dead_letter"],
    [{ id: jobId, status: "unknown" }, "unknown"],
    [{ id: jobId }, "missing"],
    [{ id: "not-a-uuid", status: "canceled" }, "invalid id"],
  ])(
    "privately rejects an invalid cancellation adapter outcome: %s",
    async (jobResult, _label) => {
      const logger = silentLogger();
      const jobs = {
        cancel: vi.fn(async () => jobResult),
      } as unknown as GenerationCancellationPort;
      const cancel = createCancelGeneration({ jobs, logger });

      await expect(cancel(principal, { jobId })).rejects.toMatchObject({
        code: "application_error",
        statusCode: 500,
        expose: false,
      });
      expect(logger.info).not.toHaveBeenCalled();
    },
  );

  it("returns and logs the actual canceling status", async () => {
    const logger = silentLogger();
    const jobs: GenerationCancellationPort = {
      cancel: vi.fn(async () => ({ id: jobId, status: "canceling" as const })),
    };
    const cancel = createCancelGeneration({ jobs, logger });

    await expect(cancel(principal, { jobId })).resolves.toEqual({
      jobId,
      status: "canceling",
    });
    expect(logger.info).toHaveBeenCalledWith(
      "Generation cancellation accepted",
      expect.objectContaining({ stage: "canceling", status: "canceling" }),
    );
  });

  it("delegates ownership enforcement to the job port and preserves status", async () => {
    const jobs: GenerationCancellationPort = {
      cancel: vi.fn(async () => ({ id: jobId, status: "canceled" as const })),
    };
    const cancel = createCancelGeneration({ jobs, logger: silentLogger() });

    await expect(cancel(principal, { jobId })).resolves.toEqual({
      jobId,
      status: "canceled",
    });
    expect(jobs.cancel).toHaveBeenCalledWith(principal, jobId);
  });

  it("preserves not-found errors from ownership/status guarded cancellation", async () => {
    const expected = new AppError({
      code: "job_not_found",
      statusCode: 404,
      message: "Job not found or already completed",
      expose: true,
    });
    const jobs: GenerationCancellationPort = {
      cancel: vi.fn(async () => {
        throw expected;
      }),
    };
    const cancel = createCancelGeneration({ jobs, logger: silentLogger() });

    await expect(cancel(principal, { jobId })).rejects.toBe(expected);
  });

  it("rejects malformed job ids without calling the job port", async () => {
    const jobs: GenerationCancellationPort = { cancel: vi.fn() };
    const cancel = createCancelGeneration({ jobs, logger: silentLogger() });
    await expect(
      cancel(principal, { jobId: "not-a-uuid" }),
    ).rejects.toMatchObject({ code: "invalid_request", statusCode: 400 });
    expect(jobs.cancel).not.toHaveBeenCalled();
  });
});

function silentLogger(): StructuredLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}
