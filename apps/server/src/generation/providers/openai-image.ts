import OpenAI from "openai";

import type {
  GeneratedImage,
  ImageGenerateParams,
  ImageProvider,
  ModelInfo,
} from "../types.js";
import { GenerationError, aspectRatioToDimensions } from "../utils.js";

const OPENAI_IMAGE_MODELS: readonly ModelInfo[] = [
  {
    id: "gpt-image-2",
    displayName: "GPT Image 2",
    description:
      "OpenAI's image generation and editing model with strong instruction following.",
    iconUrl: "https://github.com/openai.png",
  },
];

export class OpenAIImageProvider implements ImageProvider {
  readonly name = "openai";
  readonly models = OPENAI_IMAGE_MODELS;
  private client: OpenAI;

  constructor(apiKey: string, baseURL?: string) {
    this.client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
  }

  async generate(params: ImageGenerateParams): Promise<GeneratedImage> {
    const { width, height } = aspectRatioToDimensions(
      params.aspectRatio ?? "1:1",
    );
    const size = `${width}x${height}`;

    try {
      const response = await this.client.images.generate({
        model: params.model,
        prompt: params.prompt,
        size: size as "1024x1024",
        n: 1,
      });

      const image = response.data?.[0];
      const url =
        image?.url ??
        (image?.b64_json
          ? `data:image/png;base64,${image.b64_json}`
          : undefined);
      if (!url) {
        throw new GenerationError(
          "openai",
          "no_output",
          "OpenAI returned no image output",
        );
      }

      if (image?.b64_json) {
        console.info("[openai-image] Received base64 image output", {
          model: params.model,
          size,
        });
      }

      return { url, mimeType: "image/png", width, height };
    } catch (error) {
      if (error instanceof GenerationError) throw error;
      throw new GenerationError(
        "openai",
        "api_error",
        error instanceof Error ? error.message : "Unknown OpenAI error",
      );
    }
  }
}
