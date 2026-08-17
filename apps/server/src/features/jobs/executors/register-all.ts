import type { ProviderCatalog } from "../../../generation/providers/registry.js";
import { ExecutorRegistry } from "../job-executor.js";
import { createImageGenerationExecutor } from "./image-generation.js";
import { createVideoGenerationExecutor } from "./video-generation.js";

/** Construct and validate the complete worker executor catalog. */
export function registerAllExecutors(
  providerRegistry: ProviderCatalog,
): ExecutorRegistry {
  return new ExecutorRegistry()
    .register(
      "image_generation",
      createImageGenerationExecutor(providerRegistry),
    )
    .register(
      "video_generation",
      createVideoGenerationExecutor(providerRegistry),
    )
    .seal();
}
