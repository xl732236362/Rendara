import { describe, expect, it, vi } from "vitest";
import {
  buildAppFromEnv,
  buildAppWithOverrides,
  getAppUseCases,
} from "./app.js";
import { loadServerEnv } from "./config/env.js";
import { TierGuardError } from "./features/credits/tier-guard.js";
import { ProviderRegistry } from "./generation/providers/registry.js";

describe("application environment composition", () => {
  it("accepts an already parsed production environment without parsing it again", async () => {
    const env = loadServerEnv({ version: "parse-once-test" }, {});
    const app = buildAppFromEnv(env);

    expect(env.version).toBe("parse-once-test");
    expect((await app.inject({ url: "/api/health" })).statusCode).toBe(200);
    await app.close();
  });

  it("keeps partial test overrides behind validation", () => {
    expect(() => buildAppWithOverrides({ env: { port: 70_000 } })).toThrow(
      /LOOMIC_SERVER_PORT/,
    );
  });

  it("builds isolated applications twice in one process", async () => {
    const createRegistry = (providerName: string, modelId: string) =>
      new ProviderRegistry()
        .registerImageProvider({
          name: providerName,
          models: [{ id: modelId, displayName: modelId, description: modelId }],
          generate: async () => ({
            url: "data:image/png;base64,aW1hZ2U=",
            mimeType: "image/png",
            width: 1,
            height: 1,
          }),
        })
        .seal();
    const env = loadServerEnv({}, {});
    const first = buildAppFromEnv(env, {
      providerRegistry: createRegistry("first", "first/model"),
    });
    const second = buildAppFromEnv(env, {
      providerRegistry: createRegistry("second", "second/model"),
    });

    const firstModels = (
      await first.inject({ url: "/api/image-models" })
    ).json<{ models: Array<{ id: string }> }>();
    const secondModels = (
      await second.inject({ url: "/api/image-models" })
    ).json<{ models: Array<{ id: string }> }>();

    expect(firstModels.models.map((model) => model.id)).toEqual([
      "first/model",
    ]);
    expect(secondModels.models.map((model) => model.id)).toEqual([
      "second/model",
    ]);
    await Promise.all([first.close(), second.close()]);
  });

  it("rejects an injected registry with duplicate model ownership at startup", () => {
    const registry = new ProviderRegistry()
      .registerImageProvider(createImageProvider("first", "duplicate/model"))
      .registerImageProvider(createImageProvider("second", "duplicate/model"));

    expect(() =>
      buildAppFromEnv(loadServerEnv({}, {}), { providerRegistry: registry }),
    ).toThrow('Duplicate image model ID: "duplicate/model"');
  });

  it("seals an injected registry before exposing the application", async () => {
    const registry = new ProviderRegistry().registerImageProvider(
      createImageProvider("first", "first/model"),
    );

    const app = buildAppFromEnv(loadServerEnv({}, {}), {
      providerRegistry: registry,
    });

    expect(() =>
      registry.registerImageProvider(createImageProvider("late", "late/model")),
    ).toThrow("Provider registry is sealed");
    await app.close();
  });

  it("keeps canvas capabilities when queued generation is unavailable", async () => {
    let factoryOptions: Record<string, unknown> | undefined;
    const app = buildAppFromEnv(loadServerEnv({}, {}), {
      agentFactory: ((options: Record<string, unknown>) => {
        factoryOptions = options;
        return { async *streamEvents() {}, async *stream() {} };
      }) as never,
      auth: {
        authenticate: async () => ({
          accessToken: "token",
          email: "user@example.com",
          id: "user-1",
          userMetadata: {},
        }),
      },
    });

    const videoResponse = await app.inject({
      method: "POST",
      url: "/api/agent/generate-video",
      payload: { idempotency_key: "unavailable-video-1", prompt: "hello" },
    });
    const removedSkillApi = await app.inject({
      method: "POST",
      url: "/api/skills/import",
      payload: { url: "https://github.com/acme/skill" },
    });

    expect(videoResponse.statusCode).toBe(503);
    expect(removedSkillApi.statusCode).toBe(404);
    const useCases = getAppUseCases(app);
    expect(useCases.canvas.applyOperations).toBeTypeOf("function");
    expect(useCases.canvas.attachGeneratedAsset).toBeTypeOf("function");
    expect(useCases.generation).toBeUndefined();
    expect(factoryOptions).toBeUndefined();
    await app.close();
  });

  it("unrefs and clears each event-buffer cleanup timer on close", async () => {
    const unref = vi.fn();
    const timer = { unref } as unknown as NodeJS.Timeout;
    const setIntervalSpy = vi
      .spyOn(globalThis, "setInterval")
      .mockReturnValue(timer);
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

    const firstDispose = vi.fn();
    const secondDispose = vi.fn();
    const first = buildAppFromEnv(loadServerEnv({}, {}), {
      connectionManager: { dispose: firstDispose } as never,
    });
    const second = buildAppFromEnv(loadServerEnv({}, {}), {
      connectionManager: { dispose: secondDispose } as never,
    });
    await Promise.all([first.close(), second.close()]);

    expect(unref).toHaveBeenCalledTimes(2);
    expect(clearIntervalSpy).toHaveBeenCalledTimes(2);
    expect(clearIntervalSpy).toHaveBeenNthCalledWith(1, timer);
    expect(clearIntervalSpy).toHaveBeenNthCalledWith(2, timer);
    expect(firstDispose).toHaveBeenCalledOnce();
    expect(secondDispose).toHaveBeenCalledOnce();
    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });

  it("rejects malformed injected use-case groups at build time", () => {
    expect(() =>
      buildAppFromEnv(loadServerEnv({}, {}), {
        useCases: { canvas: {} } as never,
      }),
    ).toThrow(/Invalid injected useCases/);
  });

  it("snapshots and freezes injected use cases against retained mutation", async () => {
    const originalApply = vi.fn();
    const injected = {
      canvas: {
        applyOperations: originalApply,
        attachGeneratedAsset: vi.fn(),
      },
    };
    const app = buildAppFromEnv(loadServerEnv({}, {}), {
      auth: {
        authenticate: async () => ({
          accessToken: "token",
          email: "user@example.com",
          id: "user-1",
          userMetadata: {},
        }),
      },
      useCases: injected as never,
    });
    injected.canvas.applyOperations = vi.fn();

    const snapshot = getAppUseCases(app);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.canvas)).toBe(true);
    expect(snapshot.canvas.applyOperations).toBe(originalApply);
    await app.close();
  });

  it("wires requested image quality into tier authorization and cost", async () => {
    const checkResolution = vi.fn();
    const calculateCreditCost = vi.fn(
      (_model: string, _type: string, params?: { quality?: string }) =>
        ({ standard: 8, hd: 12, ultra: 20 })[params?.quality ?? "hd"] ?? 12,
    );
    const app = buildAppFromEnv(loadServerEnv({}, {}), {
      creditService: {
        getSubscription: async () => ({ plan: "ultra" }),
        deductCredits: async () => "transaction-1",
      } as never,
      jobService: generationJobService() as never,
      providerRegistry: new ProviderRegistry()
        .registerImageProvider(
          createImageProvider(
            "image-provider",
            "black-forest-labs/flux-kontext-pro",
          ),
        )
        .seal(),
      tierGuard: {
        checkModelAccess: vi.fn(),
        checkResolution,
        checkVideoResolution: vi.fn(),
        checkConcurrency: vi.fn(async () => {}),
        calculateCreditCost,
      },
    });
    await app.ready();
    const submit = getAppUseCases(app).generation?.submit;
    if (!submit) throw new Error("Generation use case was not composed");

    for (const quality of ["standard", "hd", "ultra"] as const) {
      await submit(
        {
          userId: "11111111-1111-4111-8111-111111111111",
          workspaceId: "22222222-2222-4222-8222-222222222222",
          accessToken: "token",
        },
        {
          idempotency_key: `quality-${quality}`,
          type: "image_generation",
          prompt: "draw",
          quality,
        },
      );
    }
    await submit(
      {
        userId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
      },
      {
        idempotency_key: "quality-default",
        type: "image_generation",
        prompt: "draw with default quality",
      },
    );

    expect(checkResolution.mock.calls).toEqual([
      ["ultra", "standard"],
      ["ultra", "hd"],
      ["ultra", "ultra"],
      ["ultra", "hd"],
    ]);
    expect(calculateCreditCost.mock.calls.map((call) => call[2])).toEqual([
      { quality: "standard" },
      { quality: "hd" },
      { quality: "ultra" },
      { quality: "hd" },
    ]);
    await app.close();
  });

  it("rejects the requested quality instead of authorizing the plan maximum", async () => {
    const checkResolution = vi.fn((_plan, quality) => {
      if (quality === "ultra") {
        throw new TierGuardError(
          "resolution_not_allowed",
          "Ultra is unavailable",
          403,
        );
      }
    });
    const app = buildAppFromEnv(loadServerEnv({}, {}), {
      creditService: {
        getSubscription: async () => ({ plan: "pro" }),
      } as never,
      jobService: generationJobService() as never,
      providerRegistry: new ProviderRegistry()
        .registerImageProvider(
          createImageProvider("image-provider", "image/model"),
        )
        .seal(),
      tierGuard: {
        checkModelAccess: vi.fn(),
        checkResolution,
        checkVideoResolution: vi.fn(),
        checkConcurrency: vi.fn(async () => {}),
        calculateCreditCost: vi.fn(() => 20),
      },
    });
    await app.ready();
    const submit = getAppUseCases(app).generation?.submit;
    if (!submit) throw new Error("Generation use case was not composed");

    await expect(
      submit(
        {
          userId: "11111111-1111-4111-8111-111111111111",
          workspaceId: "22222222-2222-4222-8222-222222222222",
        },
        {
          idempotency_key: "quality-rejected",
          type: "image_generation",
          prompt: "draw",
          model: "image/model",
          quality: "ultra",
        },
      ),
    ).rejects.toMatchObject({ code: "resolution_not_allowed" });
    expect(checkResolution).toHaveBeenCalledWith("pro", "ultra");
    await app.close();
  });
});

function generationJobService() {
  return {
    submitJob: async () => ({
      job: {
        id: "33333333-3333-4333-8333-333333333333",
        status: "queued",
      },
      debitTransactionId: "44444444-4444-4444-8444-444444444444",
      replayed: false,
    }),
    cancelJob: async () => ({
      id: "33333333-3333-4333-8333-333333333333",
      status: "canceled",
    }),
  };
}

function createImageProvider(name: string, modelId: string) {
  return {
    name,
    models: [{ id: modelId, displayName: modelId, description: modelId }],
    generate: async () => ({
      url: "data:image/png;base64,aW1hZ2U=",
      mimeType: "image/png",
      width: 1,
      height: 1,
    }),
  };
}
