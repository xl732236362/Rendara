import type { ProviderRegistry } from "./providers/registry.js";
import type { GeneratedVideo, VideoGenerateParams } from "./types.js";

export async function generateVideo(
  registry: ProviderRegistry,
  providerName: string,
  params: VideoGenerateParams,
): Promise<GeneratedVideo> {
  const provider = registry.getVideoProvider(providerName);
  return provider.generate(params);
}
