import { describe, expect, it, vi } from "vitest";

import { loadServerEnv } from "../../config/env.js";
import type { ImageProvider, VideoProvider } from "../types.js";
import { registerAllProviders } from "./register-all.js";
import { ProviderRegistry } from "./registry.js";

const imageProvider = (name: string, ...modelIds: string[]): ImageProvider => ({
  name,
  models: modelIds.map((id) => ({ id, displayName: id, description: id })),
  generate: vi.fn(),
});

const videoProvider = (name: string, ...modelIds: string[]): VideoProvider => ({
  name,
  models: modelIds.map((id) => ({
    id,
    displayName: id,
    description: id,
    capabilities: {
      textToVideo: true,
      imageToVideo: false,
      videoToVideo: false,
      audio: false,
    },
    limits: { maxDuration: 5, maxResolution: "720p", maxInputImages: 0 },
  })),
  generate: vi.fn(),
});

describe("ProviderRegistry", () => {
  it("builds the current provider catalog twice without contamination", () => {
    const env = loadServerEnv(
      {},
      {
        GOOGLE_API_KEY: "google-key",
        GOOGLE_VERTEX_LOCATION: "global",
        GOOGLE_VERTEX_PROJECT: "project-id",
        OPENAI_API_KEY: "openai-key",
        REPLICATE_API_TOKEN: "replicate-key",
        VOLCES_API_KEY: "volces-key",
      },
    );

    const first = registerAllProviders(env);
    const second = registerAllProviders(env);

    expect(first).not.toBe(second);
    expect(first.getAvailableImageModels()).toEqual(
      second.getAvailableImageModels(),
    );
    expect(first.getAvailableVideoModels()).toEqual(
      second.getAvailableVideoModels(),
    );
  });

  it("keeps registry instances isolated", () => {
    const first = new ProviderRegistry();
    const second = new ProviderRegistry();
    first.registerImageProvider(imageProvider("first", "image-a"));

    expect(first.getImageProvider("first").name).toBe("first");
    expect(() => second.getImageProvider("first")).toThrow(
      "No image provider registered: first",
    );
  });

  it("rejects duplicate provider names within a media type", () => {
    const registry = new ProviderRegistry();
    registry.registerImageProvider(imageProvider("duplicate", "image-a"));

    expect(() =>
      registry.registerImageProvider(imageProvider("duplicate", "image-b")),
    ).toThrow('Duplicate image provider name: "duplicate"');
  });

  it("rejects duplicate model IDs within and across providers", () => {
    const registry = new ProviderRegistry();
    registry.registerImageProvider(
      imageProvider("first", "duplicate-model", "duplicate-model"),
    );
    expect(() => registry.seal()).toThrow(
      'Duplicate image model ID: "duplicate-model"',
    );

    const acrossProviders = new ProviderRegistry();
    acrossProviders.registerImageProvider(
      imageProvider("first", "duplicate-model"),
    );
    acrossProviders.registerImageProvider(
      imageProvider("second", "duplicate-model"),
    );
    expect(() => acrossProviders.seal()).toThrow(
      'Duplicate image model ID: "duplicate-model"',
    );
  });

  it("allows the same model ID in explicit image and video namespaces", () => {
    const registry = new ProviderRegistry();
    registry.registerImageProvider(imageProvider("image", "shared-model"));
    registry.registerVideoProvider(videoProvider("video", "shared-model"));

    registry.seal();

    expect(registry.resolveImageProviderName("shared-model")).toBe("image");
    expect(registry.resolveVideoProviderName("shared-model")).toBe("video");
  });

  it("seals mutation and returns deterministic provider and model order", () => {
    const registry = new ProviderRegistry();
    registry.registerImageProvider(imageProvider("zeta", "z-model"));
    registry.registerImageProvider(
      imageProvider("alpha", "b-model", "a-model"),
    );
    registry.seal();

    expect(registry.getAvailableImageModels().map((model) => model.id)).toEqual(
      ["a-model", "b-model", "z-model"],
    );
    expect(() =>
      registry.registerImageProvider(imageProvider("late", "late-model")),
    ).toThrow("Provider registry is sealed");
  });

  it("snapshots and deeply freezes image model metadata", () => {
    const sourceModels = [
      {
        id: "stable/model",
        displayName: "Stable",
        description: "Original",
      },
    ];
    const registry = new ProviderRegistry();
    registry.registerImageProvider({
      name: "mutable-source",
      models: sourceModels,
      generate: vi.fn(),
    });
    registry.seal();

    const sourceModel = sourceModels[0];
    if (!sourceModel) throw new Error("Expected source model fixture");
    sourceModel.id = "mutated/model";
    sourceModel.description = "Mutated";
    sourceModels.push({
      id: "late/model",
      displayName: "Late",
      description: "Late",
    });
    const listed = registry.getAvailableImageModels();

    expect(listed).toEqual([
      {
        id: "stable/model",
        displayName: "Stable",
        description: "Original",
        provider: "mutable-source",
      },
    ]);
    expect(registry.resolveImageProviderName("stable/model")).toBe(
      "mutable-source",
    );
    expect(() => registry.resolveImageProviderName("mutated/model")).toThrow(
      "No provider registered for image model: mutated/model",
    );
    const listedModel = listed[0];
    if (!listedModel) throw new Error("Expected listed model");
    expect(Object.isFrozen(listedModel)).toBe(true);
    expect(() => {
      listedModel.description = "returned-list mutation";
    }).toThrow();
    listed.push({
      id: "caller-only",
      displayName: "Caller",
      description: "Caller",
      provider: "caller",
    });
    expect(registry.getAvailableImageModels()).toHaveLength(1);
  });

  it("snapshots and deeply freezes nested video model metadata", () => {
    const provider = videoProvider("video", "video/model");
    const sourceModel = provider.models[0];
    if (!sourceModel) throw new Error("Expected video model fixture");
    const registry = new ProviderRegistry()
      .registerVideoProvider(provider)
      .seal();

    (sourceModel.capabilities as { audio: boolean }).audio = true;
    (sourceModel.limits as { maxDuration: number }).maxDuration = 99;
    const listed = registry.getAvailableVideoModels();
    const snapshot = listed[0] as unknown as typeof sourceModel;

    expect(snapshot.capabilities.audio).toBe(false);
    expect(snapshot.limits.maxDuration).toBe(5);
    expect(Object.isFrozen(snapshot.capabilities)).toBe(true);
    expect(Object.isFrozen(snapshot.limits)).toBe(true);
    expect(() => {
      (snapshot.capabilities as { audio: boolean }).audio = true;
    }).toThrow();
  });

  it.each([
    ["image", "", "model", 'Invalid image provider name: ""'],
    ["image", " padded ", "model", 'Invalid image provider name: " padded "'],
    ["image", "provider", "", 'Invalid image model ID: ""'],
    ["video", "provider", " padded ", 'Invalid video model ID: " padded "'],
  ] as const)(
    "rejects invalid %s provider/model identifiers",
    (mediaType, providerName, modelId, expected) => {
      const registry = new ProviderRegistry();
      const register = () =>
        mediaType === "image"
          ? registry.registerImageProvider(imageProvider(providerName, modelId))
          : registry.registerVideoProvider(
              videoProvider(providerName, modelId),
            );

      expect(register).toThrow(expected);
    },
  );

  it("detects duplicate ownership using key presence", () => {
    const registry = new ProviderRegistry();
    registry.registerImageProvider(imageProvider("0", "__proto__"));
    registry.registerImageProvider(imageProvider("second", "__proto__"));

    expect(() => registry.seal()).toThrow(
      'Duplicate image model ID: "__proto__" (providers: "0", "second")',
    );
  });
});
