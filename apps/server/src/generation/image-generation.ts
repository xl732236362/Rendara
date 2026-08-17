import type { ProviderCatalog } from "./providers/registry.js";
import type { GeneratedImage, ImageGenerateParams } from "./types.js";

export async function generateImage(
  registry: ProviderCatalog,
  providerName: string,
  params: ImageGenerateParams,
): Promise<GeneratedImage> {
  const provider = registry.getImageProvider(providerName);
  return provider.generate(params);
}
