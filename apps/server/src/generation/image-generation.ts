import type { ProviderRegistry } from "./providers/registry.js";
import type { GeneratedImage, ImageGenerateParams } from "./types.js";

export async function generateImage(
  registry: ProviderRegistry,
  providerName: string,
  params: ImageGenerateParams,
): Promise<GeneratedImage> {
  const provider = registry.getImageProvider(providerName);
  return provider.generate(params);
}
