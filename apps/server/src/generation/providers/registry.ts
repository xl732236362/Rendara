import type {
  ImageProvider,
  ModelInfo,
  VideoModelInfo,
  VideoProvider,
} from "../types.js";
import { GenerationError } from "../utils.js";

/** Model info enriched with its owning provider name. */
export interface AvailableModel extends ModelInfo {
  provider: string;
}

/** Read-only provider capabilities exposed after application composition. */
export interface ProviderCatalog {
  getImageProvider(name: string): ImageProvider;
  getVideoProvider(name: string): VideoProvider;
  getAvailableImageModels(): AvailableModel[];
  getAvailableVideoModels(): AvailableModel[];
  resolveImageProviderName(modelId: string): string;
  resolveVideoProviderName(modelId: string): string;
}

/** Mutable during composition and immutable after validation by {@link seal}. */
export class ProviderRegistry implements ProviderCatalog {
  readonly #imageProviders = new Map<string, ImageProvider>();
  readonly #videoProviders = new Map<string, VideoProvider>();
  readonly #imageModels = new Map<string, readonly AvailableModel[]>();
  readonly #videoModels = new Map<string, readonly AvailableModel[]>();
  #imageModelOwners = new Map<string, string>();
  #videoModelOwners = new Map<string, string>();
  #sealed = false;

  registerImageProvider(provider: ImageProvider): this {
    this.#assertMutable();
    const providerName = this.#validateIdentifier(
      "image provider name",
      provider.name,
    );
    if (this.#imageProviders.has(providerName)) {
      throw new Error(`Duplicate image provider name: "${providerName}"`);
    }
    const models = this.#snapshotModels("image", providerName, provider.models);
    // Bind to the source instance so class providers retain private/runtime
    // client state while the public callable identity remains sealed.
    const facade = deepFreeze<ImageProvider>({
      name: providerName,
      models,
      generate: provider.generate.bind(provider),
    });
    this.#imageProviders.set(providerName, facade);
    this.#imageModels.set(providerName, models);
    return this;
  }

  registerVideoProvider(provider: VideoProvider): this {
    this.#assertMutable();
    const providerName = this.#validateIdentifier(
      "video provider name",
      provider.name,
    );
    if (this.#videoProviders.has(providerName)) {
      throw new Error(`Duplicate video provider name: "${providerName}"`);
    }
    const models = this.#snapshotModels("video", providerName, provider.models);
    const facade = deepFreeze<VideoProvider>({
      name: providerName,
      models: models as unknown as readonly VideoModelInfo[],
      generate: provider.generate.bind(provider),
    });
    this.#videoProviders.set(providerName, facade);
    this.#videoModels.set(providerName, models);
    return this;
  }

  seal(): this {
    if (!this.#sealed) {
      this.#imageModelOwners = this.#buildModelOwnerIndex(
        "image",
        this.#imageModels,
      );
      this.#videoModelOwners = this.#buildModelOwnerIndex(
        "video",
        this.#videoModels,
      );
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
    return this.#availableModels(this.#imageModels);
  }

  getAvailableVideoModels(): AvailableModel[] {
    return this.#availableModels(this.#videoModels);
  }

  resolveImageProviderName(modelId: string): string {
    return this.#resolveProviderName(
      "image",
      modelId,
      this.#imageModelOwners,
      this.#imageModels,
    );
  }

  resolveVideoProviderName(modelId: string): string {
    return this.#resolveProviderName(
      "video",
      modelId,
      this.#videoModelOwners,
      this.#videoModels,
    );
  }

  #assertMutable(): void {
    if (this.#sealed) throw new Error("Provider registry is sealed");
  }

  #buildModelOwnerIndex(
    mediaType: "image" | "video",
    modelsByProvider: ReadonlyMap<string, readonly AvailableModel[]>,
  ): Map<string, string> {
    const owners = new Map<string, string>();
    for (const [providerName, models] of modelsByProvider) {
      for (const model of models) {
        if (owners.has(model.id)) {
          const owner = owners.get(model.id) as string;
          throw new Error(
            `Duplicate ${mediaType} model ID: "${model.id}" (providers: "${owner}", "${providerName}")`,
          );
        }
        owners.set(model.id, providerName);
      }
    }
    return owners;
  }

  #availableModels(
    modelsByProvider: ReadonlyMap<string, readonly AvailableModel[]>,
  ): AvailableModel[] {
    return [...modelsByProvider.values()]
      .flat()
      .sort(
        (left, right) =>
          left.id.localeCompare(right.id) ||
          left.provider.localeCompare(right.provider),
      );
  }

  #resolveProviderName(
    mediaType: "image" | "video",
    modelId: string,
    owners: ReadonlyMap<string, string>,
    modelsByProvider: ReadonlyMap<string, readonly AvailableModel[]>,
  ): string {
    const indexedOwner = owners.get(modelId);
    if (indexedOwner !== undefined) return indexedOwner;

    if (!this.#sealed) {
      for (const [providerName, models] of modelsByProvider) {
        if (models.some((model) => model.id === modelId)) {
          return providerName;
        }
      }
    }
    throw new GenerationError(
      "unknown",
      "model_not_found",
      `No provider registered for ${mediaType} model: ${modelId}`,
    );
  }

  #snapshotModels(
    mediaType: "image" | "video",
    providerName: string,
    models: readonly (ModelInfo | VideoModelInfo)[],
  ): readonly AvailableModel[] {
    return Object.freeze(
      models.map((model) => {
        this.#validateIdentifier(`${mediaType} model ID`, model.id);
        const clone = JSON.parse(JSON.stringify(model)) as ModelInfo;
        return deepFreeze({ ...clone, provider: providerName });
      }),
    );
  }

  #validateIdentifier(label: string, value: string): string {
    if (value.length === 0 || value !== value.trim()) {
      throw new Error(`Invalid ${label}: "${value}"`);
    }
    return value;
  }
}

function deepFreeze<T>(value: T): T {
  if (
    value &&
    (typeof value === "object" || typeof value === "function") &&
    !Object.isFrozen(value)
  ) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
