import { describe, expect, it, vi } from "vitest";

import { createCancelGeneration } from "../../application/generation/cancel-generation.js";
import type { GenerationPrincipal } from "../../application/generation/ports.js";
import { createJobServiceGenerationPorts } from "./generation-application-adapter.js";
import type { JobService } from "./job-service.js";

const principal: GenerationPrincipal = {
  userId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "55555555-5555-4555-8555-555555555555",
  accessToken: "token",
};
const user = {
  id: principal.userId,
  accessToken: "token",
  email: "",
  userMetadata: {},
};
const jobId = "44444444-4444-4444-8444-444444444444";

describe("createJobServiceGenerationPorts", () => {
  it("maps one atomic submission call to JobService", async () => {
    const submitJob = vi.fn(async () => ({
      job: { id: jobId, status: "queued" as const },
      debitTransactionId: "77777777-7777-4777-8777-777777777777",
      replayed: false,
    }));
    const jobService = {
      submitJob,
      cancelJob: vi.fn(),
    } as unknown as JobService;
    const ports = createJobServiceGenerationPorts({
      jobService,
      toAuthenticatedUser: vi.fn(() => user),
    });
    const command = {
      principal,
      workspaceId: principal.workspaceId,
      canvasId: "33333333-3333-4333-8333-333333333333",
      jobType: "image_generation" as const,
      idempotencyKey: "request-1",
      requestFingerprint:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      creditsCost: 7,
      description: "Image generation: image/default",
      payload: { prompt: "draw", model: "image/default" },
    };

    expect(typeof ports.jobs.submit).toBe("function");
    await expect(ports.jobs.submit(command)).resolves.toEqual({
      id: jobId,
      status: "queued",
      replayed: false,
    });
    expect(submitJob).toHaveBeenCalledWith(user, {
      workspaceId: principal.workspaceId,
      canvasId: "33333333-3333-4333-8333-333333333333",
      jobType: "image_generation",
      idempotencyKey: "request-1",
      requestFingerprint:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      creditsCost: 7,
      description: "Image generation: image/default",
      payload: { prompt: "draw", model: "image/default" },
    });
  });

  it.each([
    "queued",
    "running",
    "failed",
    "cancel_requested",
    "succeeded",
    "dead_letter",
    "canceled",
  ] as const)(
    "preserves the current %s status on idempotent replay",
    async (status) => {
      const jobService = {
        submitJob: vi.fn(async () => ({
          job: { id: jobId, status },
          debitTransactionId: "77777777-7777-4777-8777-777777777777",
          replayed: true,
        })),
        cancelJob: vi.fn(),
      } as unknown as JobService;
      const ports = createJobServiceGenerationPorts({
        jobService,
        toAuthenticatedUser: () => user,
      });

      await expect(
        ports.jobs.submit({
          principal,
          workspaceId: principal.workspaceId,
          jobType: "image_generation",
          idempotencyKey: "request-replay-1",
          requestFingerprint:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          creditsCost: 7,
          description: "Image generation: image/default",
          payload: { prompt: "draw", model: "image/default" },
        }),
      ).resolves.toEqual({ id: jobId, status, replayed: true });
    },
  );

  it("rejects a non-queued status for a newly created submission", async () => {
    const jobService = {
      submitJob: vi.fn(async () => ({
        job: { id: jobId, status: "running" },
        debitTransactionId: "77777777-7777-4777-8777-777777777777",
        replayed: false,
      })),
      cancelJob: vi.fn(),
    } as unknown as JobService;
    const ports = createJobServiceGenerationPorts({
      jobService,
      toAuthenticatedUser: () => user,
    });

    await expect(
      ports.jobs.submit({
        principal,
        workspaceId: principal.workspaceId,
        jobType: "image_generation",
        idempotencyKey: "request-new-invalid",
        requestFingerprint:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        creditsCost: 7,
        description: "Image generation: image/default",
        payload: { prompt: "draw", model: "image/default" },
      }),
    ).rejects.toMatchObject({ code: "application_error" });
  });

  it("maps cancel_requested to the public canceling outcome", async () => {
    const jobService = {
      submitJob: vi.fn(),
      cancelJob: vi.fn(async () => ({ id: jobId, status: "cancel_requested" })),
    } as unknown as JobService;
    const ports = createJobServiceGenerationPorts({
      jobService,
      toAuthenticatedUser: () => user,
    });

    await expect(ports.cancellation.cancel(principal, jobId)).resolves.toEqual({
      id: jobId,
      status: "canceling",
    });
  });

  it("lets the application boundary reject cancellation for another job", async () => {
    const jobService = {
      submitJob: vi.fn(),
      cancelJob: vi.fn(async () => ({
        id: "66666666-6666-4666-8666-666666666666",
        status: "canceled",
      })),
    } as unknown as JobService;
    const ports = createJobServiceGenerationPorts({
      jobService,
      toAuthenticatedUser: () => user,
    });
    const cancel = createCancelGeneration({
      jobs: ports.cancellation,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await expect(cancel(principal, { jobId })).rejects.toMatchObject({
      code: "application_error",
      statusCode: 500,
    });
  });
});
