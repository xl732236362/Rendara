import { describe, expect, it, vi } from "vitest";
import {
  buildAppFromEnv,
  buildAppWithOverrides,
  getAppUseCases,
} from "./app.js";
import { loadServerEnv } from "./config/env.js";
import type { ServerEnv } from "./config/env.js";
import { TierGuardError } from "./features/credits/tier-guard.js";
import { ProviderRegistry } from "./generation/providers/registry.js";
import { createCursorCodec } from "./pagination/cursor-codec.js";

const ACTIVE_CURSOR_KEY_ID = "active";
const ACTIVE_CURSOR_SECRET = "active-test-secret-with-enough-entropy";
const PREVIOUS_CURSOR_KEY_ID = "previous";
const PREVIOUS_CURSOR_SECRET = "previous-test-secret-with-enough-entropy";

describe("application environment composition", () => {
  it("fails fast when the parsed environment lacks pagination cursor keys", () => {
    const secretSentinel = "must-not-appear-in-errors";
    const env = loadServerEnv({}, {});

    expect(() => buildAppFromEnv(env)).toThrow(
      "Pagination cursor active key ID and secret are required.",
    );
    const buildWithIncompletePreviousPair = () =>
      buildAppFromEnv({
        ...testApiEnv(),
        paginationCursorPreviousKey: secretSentinel,
      });
    expect(buildWithIncompletePreviousPair).toThrow(
      "Pagination cursor previous key ID and secret must be configured together.",
    );
    try {
      buildWithIncompletePreviousPair();
    } catch (error) {
      expect(String(error)).not.toContain(secretSentinel);
    }

    expect(() =>
      buildAppFromEnv({
        ...testApiEnv(),
        paginationCursorPreviousKeyId: ACTIVE_CURSOR_KEY_ID,
        paginationCursorPreviousKey: PREVIOUS_CURSOR_SECRET,
      }),
    ).toThrow("Pagination cursor active and previous key IDs must differ.");
  });

  it("accepts an already parsed production environment without parsing it again", async () => {
    const env = testApiEnv({ version: "parse-once-test" });
    const app = buildAppFromEnv(env);

    expect(env.version).toBe("parse-once-test");
    expect((await app.inject({ url: "/api/health" })).statusCode).toBe(200);
    await app.close();
  });

  it("wires active and previous keys into a default paged service", async () => {
    const timestamp = "2026-08-22T12:00:00.000Z";
    const previousCursor = createCursorCodec({
      activeKey: {
        keyId: PREVIOUS_CURSOR_KEY_ID,
        secret: PREVIOUS_CURSOR_SECRET,
      },
      now: Date.now,
    }).encode(
      {
        userId: testUser.id,
        workspaceId: "workspace-1",
        owner: "brand-kits",
        filterHash: "all",
        direction: "asc",
      },
      { id: "11111111-1111-4111-8111-111111111111", timestamp },
    );
    let appliedPreviousBoundary = false;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes("/rest/v1/brand_kits")) {
          appliedPreviousBoundary = new URL(url).searchParams.has("or");
          return jsonResponse([
            kitRow(
              "22222222-2222-4222-8222-222222222222",
              "2026-08-22T12:01:00.000Z",
            ),
            kitRow(
              "33333333-3333-4333-8333-333333333333",
              "2026-08-22T12:02:00.000Z",
            ),
          ]);
        }
        if (url.includes("/rest/v1/brand_kit_assets")) {
          return jsonResponse([]);
        }
        throw new Error(`Unexpected test request: ${new URL(url).pathname}`);
      });
    const app = buildAppFromEnv(
      testApiEnv({
        paginationCursorPreviousKeyId: PREVIOUS_CURSOR_KEY_ID,
        paginationCursorPreviousKey: PREVIOUS_CURSOR_SECRET,
        supabaseAnonKey: "test-anon-key",
        supabaseUrl: "https://example.supabase.co",
      }),
      {
        auth: { authenticate: async () => testUser },
        viewerService: {
          ensureViewer: async () => ({ workspace: { id: "workspace-1" } }),
        } as never,
      },
    );

    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/v2/brand-kits?limit=1&cursor=${encodeURIComponent(previousCursor)}`,
      });
      const page = response.json<{
        items: Array<{ id: string }>;
        nextCursor: string | null;
      }>();
      expect(response.statusCode).toBe(200);
      expect(appliedPreviousBoundary).toBe(true);
      expect(page.items[0]?.id).toBe("22222222-2222-4222-8222-222222222222");
      expect(readCursorKeyId(page.nextCursor)).toBe(ACTIVE_CURSOR_KEY_ID);
    } finally {
      await app.close();
      fetchSpy.mockRestore();
    }
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
    const env = testApiEnv();
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
      buildAppFromEnv(testApiEnv(), { providerRegistry: registry }),
    ).toThrow('Duplicate image model ID: "duplicate/model"');
  });

  it("seals an injected registry before exposing the application", async () => {
    const registry = new ProviderRegistry().registerImageProvider(
      createImageProvider("first", "first/model"),
    );

    const app = buildAppFromEnv(testApiEnv(), {
      providerRegistry: registry,
    });

    expect(() =>
      registry.registerImageProvider(createImageProvider("late", "late/model")),
    ).toThrow("Provider registry is sealed");
    await app.close();
  });

  it("fails startup when the built-in Skill catalog is invalid", async () => {
    const app = buildAppFromEnv(testApiEnv(), {
      builtinSkillCatalogLoader: async () => {
        throw new Error("skill_catalog_invalid");
      },
    });

    await expect(app.ready()).rejects.toThrow("skill_catalog_invalid");
    await app.close();
  });

  it("keeps canvas capabilities when queued generation is unavailable", async () => {
    let factoryOptions: Record<string, unknown> | undefined;
    const app = buildAppFromEnv(testApiEnv(), {
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

  it("unrefs and clears realtime maintenance timers on close", async () => {
    const unref = vi.fn();
    const timer = { unref } as unknown as NodeJS.Timeout;
    const setIntervalSpy = vi
      .spyOn(globalThis, "setInterval")
      .mockReturnValue(timer);
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

    const firstDispose = vi.fn();
    const secondDispose = vi.fn();
    const first = buildAppFromEnv(testApiEnv(), {
      connectionManager: { dispose: firstDispose } as never,
    });
    const second = buildAppFromEnv(testApiEnv(), {
      connectionManager: { dispose: secondDispose } as never,
    });
    await Promise.all([first.close(), second.close()]);

    expect(unref).toHaveBeenCalledTimes(4);
    expect(clearIntervalSpy).toHaveBeenCalledTimes(4);
    expect(clearIntervalSpy).toHaveBeenNthCalledWith(1, timer);
    expect(clearIntervalSpy).toHaveBeenNthCalledWith(2, timer);
    expect(clearIntervalSpy).toHaveBeenNthCalledWith(3, timer);
    expect(clearIntervalSpy).toHaveBeenNthCalledWith(4, timer);
    expect(firstDispose).toHaveBeenCalledOnce();
    expect(secondDispose).toHaveBeenCalledOnce();
    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });

  it("rejects malformed injected use-case groups at build time", () => {
    expect(() =>
      buildAppFromEnv(testApiEnv(), {
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
    const app = buildAppFromEnv(testApiEnv(), {
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
    const app = buildAppFromEnv(testApiEnv(), {
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
    const app = buildAppFromEnv(testApiEnv(), {
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

function testApiEnv(overrides: Partial<ServerEnv> = {}): ServerEnv {
  return loadServerEnv(
    {
      paginationCursorActiveKeyId: ACTIVE_CURSOR_KEY_ID,
      paginationCursorActiveKey: ACTIVE_CURSOR_SECRET,
      ...overrides,
    },
    {},
  );
}

function readCursorKeyId(cursor: string | null): unknown {
  if (!cursor) return null;
  const [payloadSegment] = cursor.split(".", 1);
  if (!payloadSegment) return null;
  const payload = JSON.parse(
    Buffer.from(payloadSegment, "base64url").toString("utf8"),
  ) as Record<string, unknown>;
  return payload.keyId;
}

function kitRow(id: string, timestamp: string) {
  return {
    id,
    name: id,
    is_default: false,
    cover_url: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

const testUser = {
  accessToken: "token",
  email: "user@example.com",
  id: "user-1",
  userMetadata: {},
};
