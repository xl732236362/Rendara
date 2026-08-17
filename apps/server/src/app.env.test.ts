import { describe, expect, it } from "vitest";
import { buildAppFromEnv, buildAppWithOverrides } from "./app.js";
import { loadServerEnv } from "./config/env.js";
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
});

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
