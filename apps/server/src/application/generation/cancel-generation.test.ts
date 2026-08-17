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

describe("CancelGeneration", () => {
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
