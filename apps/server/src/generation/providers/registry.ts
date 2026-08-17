import type { ImageProvider, ModelInfo, VideoProvider } from "../types.js";
import { GenerationError } from "../utils.js";

/** Model info enriched with its owning provider name. */
export interface AvailableModel extends ModelInfo {
  provider: string;
}

/** Mutable during composition and immutable after validation by {@link seal}. */
export class ProviderRegistry {
  readonly #imageProviders = new Map<string, ImageProvider>();
  readonly #videoProviders = new Map<string, VideoProvider>();
  #sealed = false;

  registerImageProvider(provider: ImageProvider): this {
    this.#assertMutable();
    if (this.#imageProviders.has(provider.name)) {
      throw new Error(`Duplicate image provider name: "${provider.name}"`);
    }
    this.#imageProviders.set(provider.name, provider);
    return this;
  }

  registerVideoProvider(provider: VideoProvider): this {
    this.#assertMutable();
    if (this.#videoProviders.has(provider.name)) {
      throw new Error(`Duplicate video provider name: "${provider.name}"`);
    }
    this.#videoProviders.set(provider.name, provider);
    return this;
  }

  seal(): this {
    if (!this.#sealed) {
      this.#assertUniqueModels("image", this.#imageProviders.values());
      this.#assertUniqueModels("video", this.#videoProviders.values());
      this.#sealed = true;
    }
    return this;
  }

  getImageProvider(name: string): ImageProvider {
    const provider = this.#imageProviders.get(name);
    if (!provider) {
      throw new GenerationError(
        name,
        "provider_not_found",
        `No image provider registered: ${name}`,
      );
    }
    return provider;
  }

  getVideoProvider(name: string): VideoProvider {
    const provider = this.#videoProviders.get(name);
    if (!provider) {
      throw new GenerationError(
        name,
        "provider_not_found",
        `No video provider registered: ${name}`,
      );
    }
    return provider;
  }

  getAvailableImageModels(): AvailableModel[] {
    return this.#availableModels(this.#imageProviders.values());
  }

  getAvailableVideoModels(): AvailableModel[] {
    return this.#availableModels(this.#videoProviders.values());
  }

  resolveImageProviderName(modelId: string): string {
    return this.#resolveProviderName("image", modelId, this.#imageProviders);
  }

  resolveVideoProviderName(modelId: string): string {
    return this.#resolveProviderName("video", modelId, this.#videoProviders);
  }

  #assertMutable(): void {
    if (this.#sealed) throw new Error("Provider registry is sealed");
  }

  #assertUniqueModels(
    mediaType: "image" | "video",
    providers: Iterable<ImageProvider | VideoProvider>,
  ): void {
    const owners = new Map<string, string>();
    for (const provider of providers) {
      for (const model of provider.models) {
        const owner = owners.get(model.id);
        if (owner) {
          throw new Error(
            `Duplicate ${mediaType} model ID: "${model.id}" (providers: "${owner}", "${provider.name}")`,
          );
        }
        owners.set(model.id, provider.name);
      }
    }
  }

  #availableModels(
    providers: Iterable<ImageProvider | VideoProvider>,
  ): AvailableModel[] {
    return [...providers]
      .flatMap((provider) =>
        provider.models.map((model) => ({ ...model, provider: provider.name })),
      )
      .sort(
        (left, right) =>
          left.id.localeCompare(right.id) ||
          left.provider.localeCompare(right.provider),
      );
  }

  #resolveProviderName(
    mediaType: "image" | "video",
    modelId: string,
    providers: ReadonlyMap<string, ImageProvider | VideoProvider>,
  ): string {
    for (const provider of providers.values()) {
      if (provider.models.some((model) => model.id === modelId)) {
        return provider.name;
      }
    }
    throw new GenerationError(
      "unknown",
      "model_not_found",
      `No provider registered for ${mediaType} model: ${modelId}`,
    );
  }
}
