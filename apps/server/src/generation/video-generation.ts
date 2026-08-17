import type { ProviderCatalog } from "./providers/registry.js";
import type { GeneratedVideo, VideoGenerateParams } from "./types.js";

export async function generateVideo(
  registry: ProviderCatalog,
  providerName: string,
  params: VideoGenerateParams,
): Promise<GeneratedVideo> {
  const provider = registry.getVideoProvider(providerName);
  return provider.generate(params);
}
