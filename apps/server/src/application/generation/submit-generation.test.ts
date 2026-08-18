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
      getBalance: vi.fn(async () => ({
        balance: 100,
        plan: "pro" as const,
        dailyClaimed: false,
      })),
    },
    referenceAssets: {
      authorize: vi.fn(async () => {
        calls.push("reference-assets");
      }),
    },
    jobs: {
      submit: vi.fn(async () => {
        calls.push("submit");
        return { id: ids.job, status: "queued" as const, replayed: false };
      }),
    },
    cancellation: {
      cancel: vi.fn(async () => ({
        id: ids.job,
        status: "canceled" as const,
      })),
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
  it("submits the authorized charge and job atomically", async () => {
    const { ports, submit } = setup();

    await expect(
      submit(principal, {
        type: "image_generation",
        idempotency_key: "request-atomic-1",
        prompt: "draw",
      }),
    ).resolves.toEqual({ jobId: ids.job, status: "queued" });

    expect(ports.jobs.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        creditsCost: 7,
        idempotencyKey: "request-atomic-1",
        jobType: "image_generation",
        description: "Image generation: image/default",
      }),
    );
    expect(ports.cancellation.cancel).not.toHaveBeenCalled();
  });

  it("does not include the idempotency key in the request fingerprint", async () => {
    const { ports, submit } = setup();

    await submit(principal, {
      type: "image_generation",
      idempotency_key: "request-1",
      prompt: "same effect",
    });
    await submit(principal, {
      type: "image_generation",
      idempotency_key: "request-2",
      prompt: "same effect",
    });

    const commands = vi
      .mocked(ports.jobs.submit)
      .mock.calls.map(([value]) => value);
    expect(commands[0]?.requestFingerprint).toBe(
      commands[1]?.requestFingerprint,
    );
  });

  it.each(["standard", "hd", "ultra"] as const)(
    "uses requested %s quality for authorization, cost, and the atomic payload",
    async (quality) => {
      const { ports, submit } = setup();
      const request = {
        type: "image_generation" as const,
        idempotency_key: `quality-${quality}`,
        prompt: "draw",
        quality,
      };

      await submit(principal, request);

      expect(ports.tiers.authorizeMedia).toHaveBeenCalledWith("pro", request);
      expect(ports.tiers.calculateCreditCost).toHaveBeenCalledWith(
        "image/default",
        request,
      );
      expect(ports.jobs.submit).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ quality, model: "image/default" }),
        }),
      );
    },
  );

  it("preserves video-only fields in the atomic payload", async () => {
    const { ports, submit } = setup();
    const request = {
      type: "video_generation" as const,
      idempotency_key: "video-1",
      prompt: "animate",
      model: "video/v2",
      duration: 8,
      resolution: "1080p",
      enable_audio: true,
    };

    await submit(principal, request);

    expect(ports.jobs.submit).toHaveBeenCalledWith(
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

  it("performs tier validation before atomic submission", async () => {
    const { calls, submit } = setup();

    await submit(principal, {
      type: "image_generation",
      idempotency_key: "order-1",
      prompt: "draw",
    });

    expect(calls).toEqual([
      "resolve:image_generation",
      "plan",
      "model-access",
      "media-access",
      "concurrency",
      "cost",
      "submit",
    ]);
  });

  it("authorizes reference assets before atomic submission", async () => {
    const { calls, ports, submit } = setup();

    await submit(principal, {
      type: "image_generation",
      idempotency_key: "reference-order-1",
      project_id: ids.project,
      canvas_id: ids.canvas,
      prompt: "draw from reference",
      input_asset_ids: ["66666666-6666-4666-8666-666666666666"],
    });

    expect(ports.referenceAssets?.authorize).toHaveBeenCalledWith({
      principal,
      projectId: ids.project,
      assetIds: ["66666666-6666-4666-8666-666666666666"],
    });
    expect(calls.indexOf("reference-assets")).toBeLessThan(
      calls.indexOf("submit"),
    );
  });

  it("never submits when reference asset authorization fails", async () => {
    const { ports, submit } = setup();
    vi.mocked(ports.referenceAssets!.authorize).mockRejectedValue(
      new AppError({
        code: "forbidden",
        statusCode: 403,
        message: "Reference asset is unavailable.",
        expose: true,
      }),
    );

    await expect(
      submit(principal, {
        type: "image_generation",
        idempotency_key: "reference-denied-1",
        project_id: ids.project,
        canvas_id: ids.canvas,
        prompt: "draw from reference",
        input_asset_ids: ["66666666-6666-4666-8666-666666666666"],
      }),
    ).rejects.toMatchObject({ code: "forbidden", statusCode: 403 });
    expect(ports.jobs.submit).not.toHaveBeenCalled();
  });

  it("rejects invalid payloads before calling ports", async () => {
    const { ports, submit } = setup();

    await expect(
      submit(principal, {
        type: "image_generation",
        idempotency_key: "invalid-1",
        prompt: "draw",
        input_video: "https://example.test/video.mp4",
      }),
    ).rejects.toMatchObject({ code: "invalid_request", statusCode: 400 });
    expect(ports.models.resolveModel).not.toHaveBeenCalled();
    expect(ports.jobs.submit).not.toHaveBeenCalled();
  });

  it("preserves model authorization failures and never submits", async () => {
    const { ports, submit } = setup();
    vi.mocked(ports.tiers.authorizeModel).mockImplementation(() => {
      throw new AppError({
        code: "model_not_accessible",
        statusCode: 403,
        message: "Model unavailable.",
        expose: true,
      });
    });

    await expect(
      submit(principal, {
        type: "image_generation",
        idempotency_key: "private-model-1",
        prompt: "draw",
        model: "private/model",
      }),
    ).rejects.toMatchObject({ code: "model_not_accessible", statusCode: 403 });
    expect(ports.jobs.submit).not.toHaveBeenCalled();
  });

  it("enriches atomic insufficient-credit failures without compensating", async () => {
    const { ports, submit } = setup();
    vi.mocked(ports.jobs.submit).mockRejectedValue(
      new AppError({
        code: "insufficient_credits",
        statusCode: 402,
        message: "Insufficient credits.",
        expose: true,
      }),
    );
    vi.mocked(ports.credits!.getBalance).mockResolvedValue({
      balance: 2,
      plan: "pro",
      dailyClaimed: true,
    });

    await expect(
      submit(principal, {
        type: "image_generation",
        idempotency_key: "insufficient-1",
        prompt: "draw",
      }),
    ).rejects.toMatchObject({
      code: "insufficient_credits",
      details: {
        balance: 2,
        requiredAmount: 7,
        plan: "pro",
        dailyClaimed: true,
      },
    });
    expect(ports.cancellation.cancel).not.toHaveBeenCalled();
  });

  it("privately rejects an invalid atomic adapter outcome", async () => {
    const { ports, submit } = setup();
    vi.mocked(ports.jobs.submit).mockResolvedValue({
      id: "not-a-uuid",
      status: "queued",
      replayed: false,
    });

    await expect(
      submit(principal, {
        type: "image_generation",
        idempotency_key: "invalid-outcome-1",
        prompt: "draw",
      }),
    ).rejects.toMatchObject({
      code: "application_error",
      statusCode: 500,
      expose: false,
    });
  });

  it("logs identifiers and stages without prompt, access token, or raw key", async () => {
    const { logger, submit } = setup();
    await submit(principal, {
      type: "image_generation",
      idempotency_key: "secret-request-key",
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
    expect(serialized).not.toContain("highly secret prompt");
    expect(serialized).not.toContain(principal.accessToken);
    expect(serialized).not.toContain("secret-request-key");
  });
});
