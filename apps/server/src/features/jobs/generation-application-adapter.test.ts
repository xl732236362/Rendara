import { describe, expect, it, vi } from "vitest";

import { createCancelGeneration } from "../../application/generation/cancel-generation.js";
import type { GenerationPrincipal } from "../../application/generation/ports.js";
import { createSubmitGeneration } from "../../application/generation/submit-generation.js";
import { createJobServiceGenerationPorts } from "./generation-application-adapter.js";
import { type JobService, createJobService } from "./job-service.js";

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
  it("surfaces a Supabase credit attachment error with safe JobService semantics", async () => {
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const databaseError = {
      message: "internal database detail",
      code: "XX000",
    };
    const jobService = createJobService({
      createUserClient: vi.fn() as never,
      getAdminClient: () => creditAttachmentAdmin(databaseError),
      pgmq: { send: vi.fn() } as never,
    });

    await expect(
      jobService.setCreditsInfo(jobId, 7, "tx-1"),
    ).rejects.toMatchObject({
      code: "job_create_failed",
      statusCode: 500,
      message: "Failed to attach credits to job.",
      cause: databaseError,
    });
    expect(errorLog).toHaveBeenCalledWith(
      "[job-service] setCreditsInfo update failed",
      { jobId, code: "XX000", message: "internal database detail" },
    );
    errorLog.mockRestore();
  });

  it("triggers submission cleanup when the real JobService attachment update fails", async () => {
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const databaseError = {
      message: "internal database detail",
      code: "XX000",
    };
    const jobService = createJobService({
      createUserClient: vi.fn() as never,
      getAdminClient: () => creditAttachmentAdmin(databaseError),
      pgmq: { send: vi.fn() } as never,
    });
    const adapter = createJobServiceGenerationPorts({
      jobService,
      toAuthenticatedUser: () => user,
    });
    const cancellation = vi.fn(async () => ({
      id: jobId,
      status: "canceled" as const,
    }));
    const submit = createSubmitGeneration({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      ports: {
        jobs: {
          create: vi.fn(async () => ({ id: jobId, status: "queued" as const })),
          attachCredits: adapter.jobs.attachCredits,
        },
        cancellation: { cancel: cancellation },
        models: { resolveModel: () => "image/default" },
        tiers: {
          getPlan: vi.fn(async () => "pro" as const),
          authorizeModel: vi.fn(),
          authorizeMedia: vi.fn(),
          authorizeConcurrency: vi.fn(async () => undefined),
          calculateCreditCost: vi.fn(() => 7),
        },
        credits: { deduct: vi.fn(async () => "tx-1") },
      },
    });

    await expect(
      submit(principal, { type: "image_generation", prompt: "draw" }),
    ).rejects.toMatchObject({
      code: "job_create_failed",
      statusCode: 500,
      cause: expect.objectContaining({ cause: databaseError }),
    });
    expect(cancellation).toHaveBeenCalledWith(principal, jobId);
    errorLog.mockRestore();
  });

  it("explicitly maps queued submission and cancellation calls", async () => {
    const jobService = {
      createJob: vi.fn(async () => ({ id: jobId, status: "queued" })),
      cancelJob: vi.fn(async () => ({ id: jobId, status: "canceled" })),
      setCreditsInfo: vi.fn(async () => undefined),
    } as unknown as JobService;
    const ports = createJobServiceGenerationPorts({
      jobService,
      toAuthenticatedUser: vi.fn(() => user),
    });

    await expect(
      ports.jobs.create({
        principal,
        workspaceId: principal.workspaceId,
        canvasId: "33333333-3333-4333-8333-333333333333",
        jobType: "image_generation",
        payload: { prompt: "draw" },
      }),
    ).resolves.toEqual({ id: jobId, status: "queued" });
    await expect(ports.cancellation.cancel(principal, jobId)).resolves.toEqual({
      id: jobId,
      status: "canceled",
    });
    expect(jobService.createJob).toHaveBeenCalledWith(user, {
      workspaceId: principal.workspaceId,
      canvasId: "33333333-3333-4333-8333-333333333333",
      jobType: "image_generation",
      payload: { prompt: "draw" },
    });
  });

  it("rejects a legacy create result that is no longer queued", async () => {
    const jobService = {
      createJob: vi.fn(async () => ({ id: jobId, status: "running" })),
      cancelJob: vi.fn(),
      setCreditsInfo: vi.fn(),
    } as unknown as JobService;
    const ports = createJobServiceGenerationPorts({
      jobService,
      toAuthenticatedUser: () => user,
    });

    await expect(
      ports.jobs.create({
        principal,
        workspaceId: principal.workspaceId,
        jobType: "image_generation",
        payload: { prompt: "draw" },
      }),
    ).rejects.toMatchObject({ code: "application_error", statusCode: 500 });
  });

  it("lets the application boundary reject a legacy cancellation result for another job", async () => {
    const jobService = {
      createJob: vi.fn(),
      cancelJob: vi.fn(async () => ({
        id: "66666666-6666-4666-8666-666666666666",
        status: "canceled",
      })),
      setCreditsInfo: vi.fn(),
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

function creditAttachmentAdmin(error: unknown) {
  return {
    from: vi.fn(() => ({
      update: vi.fn(() => ({
        eq: vi.fn(async () => ({ data: null, error })),
      })),
    })),
  } as never;
}
