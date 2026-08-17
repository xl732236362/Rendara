import { describe, expect, it, vi } from "vitest";

import { AppError } from "../../errors/app-error.js";
import type {
  GenerationApplicationPorts,
  GenerationPrincipal,
  StructuredLogger,
} from "./ports.js";
import { createSubmitGeneration } from "./submit-generation.js";

const ids = {
  canvas: "33333333-3333-4333-8333-333333333333",
  job: "44444444-4444-4444-8444-444444444444",
  project: "22222222-2222-4222-8222-222222222222",
  user: "11111111-1111-4111-8111-111111111111",
  workspace: "55555555-5555-4555-8555-555555555555",
};

const principal: GenerationPrincipal = {
  userId: ids.user,
  workspaceId: ids.workspace,
  accessToken: "secret-access-token",
};

function setup() {
  const calls: string[] = [];
  const ports: GenerationApplicationPorts = {
    models: {
      resolveModel: vi.fn((type, requested) => {
        calls.push(`resolve:${type}`);
        return (
          requested ??
          (type === "image_generation" ? "image/default" : "video/default")
        );
      }),
    },
    tiers: {
      getPlan: vi.fn(async () => {
        calls.push("plan");
        return "pro" as const;
      }),
      authorizeModel: vi.fn(() => calls.push("model-access")),
      authorizeMedia: vi.fn(() => calls.push("media-access")),
      authorizeConcurrency: vi.fn(async () => {
        calls.push("concurrency");
      }),
      calculateCreditCost: vi.fn(() => {
        calls.push("cost");
        return 7;
      }),
    },
    credits: {
      deduct: vi.fn(async () => {
        calls.push("deduct");
        return "tx-1";
      }),
    },
    jobs: {
      create: vi.fn(async () => {
        calls.push("create");
        return { id: ids.job, status: "queued" as const };
      }),
      attachCredits: vi.fn(async () => {
        calls.push("attach");
      }),
    },
    cancellation: {
      cancel: vi.fn(async () => {
        calls.push("cancel");
        return { id: ids.job, status: "canceled" as const };
      }),
    },
  };
  const logger: StructuredLogger = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  };
  return {
    calls,
    logger,
    ports,
    submit: createSubmitGeneration({ logger, ports }),
  };
}

describe("SubmitGeneration", () => {
  it.each([
    [{ id: ids.job, status: "running" }, "unexpected create status"],
    [{ id: "not-a-uuid", status: "queued" }, "invalid create id"],
    [{ id: ids.job }, "missing create status"],
  ])(
    "privately rejects an invalid job adapter result: %s",
    async (jobResult, _label) => {
      const { logger, ports, submit } = setup();
      vi.mocked(ports.jobs.create).mockResolvedValue(jobResult as never);

      await expect(
        submit(principal, { type: "image_generation", prompt: "draw" }),
      ).rejects.toMatchObject({
        code: "application_error",
        statusCode: 500,
        expose: false,
      });
      expect(logger.info).not.toHaveBeenCalled();
      expect(ports.credits?.deduct).not.toHaveBeenCalled();
    },
  );

  it("rejects invalid and media-mismatched payloads before calling ports", async () => {
    const { ports, submit } = setup();

    await expect(
      submit(principal, {
        type: "image_generation",
        prompt: "draw",
        input_video: "https://example.test/video.mp4",
      }),
    ).rejects.toMatchObject({ code: "invalid_request", statusCode: 400 });
    expect(ports.models.resolveModel).not.toHaveBeenCalled();
    expect(ports.jobs.create).not.toHaveBeenCalled();
  });

  it("resolves the default model and submits a validated image payload with context", async () => {
    const { ports, submit } = setup();

    await expect(
      submit(principal, {
        type: "image_generation",
        prompt: "draw",
        project_id: ids.project,
        canvas_id: ids.canvas,
        aspect_ratio: "16:9",
      }),
    ).resolves.toEqual({ jobId: ids.job, status: "queued" });

    expect(ports.models.resolveModel).toHaveBeenCalledWith(
      "image_generation",
      undefined,
    );
    expect(ports.jobs.create).toHaveBeenCalledWith({
      principal,
      workspaceId: ids.workspace,
      projectId: ids.project,
      canvasId: ids.canvas,
      jobType: "image_generation",
      payload: { prompt: "draw", model: "image/default", aspect_ratio: "16:9" },
    });
  });

  it("keeps video-only fields and passes them to tier validation and the job", async () => {
    const { ports, submit } = setup();
    const request = {
      type: "video_generation" as const,
      prompt: "animate",
      model: "video/v2",
      duration: 8,
      resolution: "1080p",
      input_images: ["https://example.test/a.png"],
      enable_audio: true,
    };

    await submit(principal, request);

    expect(ports.tiers.authorizeMedia).toHaveBeenCalledWith("pro", request);
    expect(ports.jobs.create).toHaveBeenCalledWith(
      expect.objectContaining({
        jobType: "video_generation",
        payload: expect.objectContaining({
          model: "video/v2",
          duration: 8,
          resolution: "1080p",
          enable_audio: true,
        }),
      }),
    );
  });

  it("performs tier validation before job creation and credit deduction", async () => {
    const { calls, submit } = setup();
    await submit(principal, { type: "image_generation", prompt: "draw" });
    expect(calls).toEqual([
      "resolve:image_generation",
      "plan",
      "model-access",
      "media-access",
      "concurrency",
      "cost",
      "create",
      "deduct",
      "attach",
    ]);
  });

  it("preserves inaccessible-model AppError code/status and never creates a job", async () => {
    const { ports, submit } = setup();
    vi.mocked(ports.tiers.authorizeModel).mockImplementation(() => {
      throw new AppError({
        code: "model_not_accessible",
        statusCode: 403,
        message: "Upgrade required",
        expose: true,
      });
    });

    await expect(
      submit(principal, {
        type: "image_generation",
        prompt: "draw",
        model: "private/model",
      }),
    ).rejects.toMatchObject({ code: "model_not_accessible", statusCode: 403 });
    expect(ports.jobs.create).not.toHaveBeenCalled();
  });

  it("cancels the created job and preserves a deduction failure", async () => {
    const { calls, ports, submit } = setup();
    const credits = ports.credits;
    if (!credits) throw new Error("test setup requires credits");
    vi.mocked(credits.deduct).mockImplementation(async () => {
      calls.push("deduct");
      throw new AppError({
        code: "insufficient_credits",
        statusCode: 402,
        message: "Not enough credits",
        expose: true,
      });
    });

    await expect(
      submit(principal, { type: "image_generation", prompt: "draw" }),
    ).rejects.toMatchObject({ code: "insufficient_credits", statusCode: 402 });
    expect(ports.cancellation.cancel).toHaveBeenCalledWith(principal, ids.job);
  });

  it("preserves the submission error and logs cleanup_failed when cancellation returns another job", async () => {
    const { logger, ports, submit } = setup();
    const original = new AppError({
      code: "credit_deduct_failed",
      statusCode: 500,
      message: "Deduction failed",
    });
    const credits = ports.credits;
    if (!credits) throw new Error("test setup requires credits");
    vi.mocked(credits.deduct).mockRejectedValue(original);
    vi.mocked(ports.cancellation.cancel).mockResolvedValue({
      id: "66666666-6666-4666-8666-666666666666",
      status: "canceled",
    });

    await expect(
      submit(principal, { type: "image_generation", prompt: "draw" }),
    ).rejects.toBe(original);
    expect(logger.warn).not.toHaveBeenCalledWith(
      "Generation job canceled after submission failure",
      expect.anything(),
    );
    expect(logger.error).toHaveBeenCalledWith(
      "Generation job cleanup failed",
      expect.objectContaining({ stage: "cleanup_failed", jobId: ids.job }),
    );
  });

  it("cancels after credit metadata attachment fails without masking the failure", async () => {
    const { ports, submit } = setup();
    vi.mocked(ports.jobs.attachCredits).mockRejectedValue(
      new AppError({
        code: "job_create_failed",
        statusCode: 500,
        message: "Failed to attach credits",
      }),
    );

    await expect(
      submit(principal, { type: "video_generation", prompt: "animate" }),
    ).rejects.toMatchObject({ code: "job_create_failed", statusCode: 500 });
    expect(ports.cancellation.cancel).toHaveBeenCalledWith(principal, ids.job);
  });

  it("logs identifiers and stages without prompt or access token", async () => {
    const { logger, submit } = setup();
    await submit(principal, {
      type: "image_generation",
      prompt: "highly secret prompt",
      model: "image/v1",
    });

    const serialized = JSON.stringify([
      ...vi.mocked(logger.info).mock.calls,
      ...vi.mocked(logger.warn).mock.calls,
      ...vi.mocked(logger.error).mock.calls,
    ]);
    expect(serialized).toContain(ids.job);
    expect(serialized).toContain(ids.user);
    expect(serialized).toContain(ids.workspace);
    expect(serialized).toContain("image/v1");
    expect(serialized).toContain("stage");
    expect(serialized).not.toContain("highly secret prompt");
    expect(serialized).not.toContain("secret-access-token");
  });
});
