import { describe, expect, it, vi } from "vitest";

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
});
