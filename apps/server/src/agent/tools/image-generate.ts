import type { ToolRuntime } from "@langchain/core/tools";
import { tool } from "langchain";
import { z } from "zod";

import { generateImage } from "../../generation/image-generation.js";
import type {
  AvailableModel,
  ProviderCatalog,
} from "../../generation/providers/registry.js";
import {
  GeneratedAssetAttachmentError,
  type GeneratedMediaToolResult,
  generatedMediaSummary,
  generatedMediaToolResultSchema,
} from "../generated-media-result.js";

const DEFAULT_MODEL = "black-forest-labs/flux-kontext-pro";

const finiteCanvasCoordinate = z
  .number()
  .finite()
  .min(-1_000_000)
  .max(1_000_000);
const explicitDimension = z.number().finite().min(1).max(16_384);
const relativeDimension = z.number().finite().min(1).max(4_096);

export const imagePlacementSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("auto_right") }).strict(),
  z
    .object({
      kind: z.literal("explicit"),
      x: finiteCanvasCoordinate,
      y: finiteCanvasCoordinate,
      width: explicitDimension,
      height: explicitDimension,
    })
    .strict(),
  z
    .object({
      kind: z.literal("relative"),
      elementId: z.string().trim().min(1).max(256),
      relation: z.enum(["above", "below", "left", "right"]),
      gap: z.number().finite().min(0).max(400).default(48),
      maxWidth: relativeDimension.optional(),
      maxHeight: relativeDimension.optional(),
    })
    .strict(),
]);

export type ImagePlacement = z.infer<typeof imagePlacementSchema>;

export class RelativePlacementRequiresAttachmentBackendError extends Error {
  readonly code = "relative_placement_requires_attachment_backend" as const;

  constructor() {
    super("Relative image placement requires the attachment backend.");
    this.name = "RelativePlacementRequiresAttachmentBackendError";
  }
}

/**
 * Build the zod schema dynamically from the models available in the registry.
 * Falls back to a plain string field when no providers are registered.
 */
function buildImageGenerateSchema(models: AvailableModel[]) {
  const modelIds = models.map((m) => m.id);
  const defaultModel = modelIds.includes(DEFAULT_MODEL)
    ? DEFAULT_MODEL
    : (modelIds[0] ?? DEFAULT_MODEL);

  const modelDescription = models.length
    ? `Model to use. Available:\n${models.map((m) => `- ${m.id}: ${m.displayName} — ${m.description}`).join("\n")}`
    : "Model identifier (no providers currently registered)";

  // z.enum needs [string, ...string[]], but we may have 0 models at test time.
  const modelField =
    modelIds.length >= 1
      ? z
          .enum(modelIds as [string, ...string[]])
          .default(defaultModel as (typeof modelIds)[number])
          .describe(modelDescription)
      : z.string().default(DEFAULT_MODEL).describe(modelDescription);

  return z
    .object({
      title: z
        .string()
        .min(1)
        .describe(
          "Short descriptive title for the generated image, used as metadata so the image content is understood without re-analysis",
        ),
      prompt: z.string().min(1).describe("Detailed image generation prompt"),
      model: modelField,
      aspectRatio: z
        .string()
        .optional()
        .default("1:1")
        .describe(
          "Aspect ratio (e.g. 1:1, 16:9, 9:16, 4:3, 3:4, 4:5, 5:4, 2:3, 3:2). Provider auto-normalizes unsupported ratios to nearest match.",
        ),
      quality: z
        .enum(["standard", "hd", "ultra"])
        .optional()
        .default("hd")
        .describe(
          "Image quality/resolution level. standard: ~1K fast preview, hd: ~2K production quality (default), ultra: ~4K print quality (not all models support this, will use max available).",
        ),
      outputFormat: z
        .enum(["png", "jpg", "webp"])
        .optional()
        .describe(
          "Output image format. PNG for transparency, JPG for photos, WebP for web.",
        ),
      inputImages: z
        .array(opaqueAssetIdSchema)
        .optional()
        .describe("Authorized reference asset IDs for editing/transformation."),
      placement: imagePlacementSchema
        .optional()
        .default({ kind: "auto_right" })
        .describe(
          "Canvas placement. Use relative to place below, above, left, or right of a referenced element; omit for automatic right-side placement.",
        ),
    })
    .strict();
}

const opaqueAssetIdSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !/^(?:https?:|data:|file:)/i.test(value), {
    message: "raw_url_not_allowed",
  });

type ImageGenerateInput = {
  title: string;
  prompt: string;
  model: string;
  aspectRatio?: string;
  quality?: string;
  outputFormat?: string;
  inputImages?: string[];
  placement?: ImagePlacement;
};

type ImageGenerateResult = {
  summary: string;
  title?: string;
  elementId?: string;
  imageUrl?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  error?: string;
  jobId?: string;
  jobType?: "image_generation";
  placement?: { x: number; y: number; width: number; height: number };
};

/**
 * Optional function to persist a generated image to OSS.
 * Accepts the ephemeral URL and returns a persistent signed URL.
 */
export type PersistImageFn = (
  sourceUrl: string,
  mimeType: string,
  prompt: string,
) => Promise<string>;

/**
 * Submit an image generation job and wait for it to complete.
 * Returns the final result: signed_url on success, error on failure.
 */
export type SubmitImageJobFn = (input: {
  logicalToolCallId: string;
  prompt: string;
  title: string;
  model: string;
  aspectRatio: string;
  inputImages?: string[];
  quality?: string;
  placement?: ImagePlacement;
}) => Promise<GeneratedMediaToolResult>;

export async function runImageGenerate(
  input: ImageGenerateInput,
  persistImage?: PersistImageFn,
  submitImageJob?: SubmitImageJobFn,
  attachmentMap?: Record<string, string>,
  providerRegistry?: ProviderCatalog,
  logicalToolCallId?: string,
): Promise<ImageGenerateResult | GeneratedMediaToolResult> {
  const t0 = Date.now();
  const lap = (label: string, extra?: Record<string, unknown>) => {
    console.log(
      `[generate_image] ${label} +${Date.now() - t0}ms`,
      extra ? JSON.stringify(extra) : "",
    );
  };

  // Resolve assetId references in inputImages to base64 data URIs
  if (input.inputImages?.length && attachmentMap) {
    input = {
      ...input,
      inputImages: input.inputImages.map((ref) => attachmentMap[ref] ?? ref),
    };
  }

  // Filter out invalid image references — only keep valid URLs.
  // Agent may pass canvas element IDs or unresolved assetIds that aren't
  // in the attachmentMap. These would cause Replicate 422 errors.
  if (input.inputImages?.length) {
    const validImages = input.inputImages.filter(
      (img) =>
        img.startsWith("http://") ||
        img.startsWith("https://") ||
        img.startsWith("data:"),
    );
    if (validImages.length !== input.inputImages.length) {
      lap("filtered_invalid_refs", {
        before: input.inputImages.length,
        after: validImages.length,
        dropped: input.inputImages.filter(
          (img) =>
            !img.startsWith("http://") &&
            !img.startsWith("https://") &&
            !img.startsWith("data:"),
        ),
      });
    }
    input =
      validImages.length > 0
        ? { ...input, inputImages: validImages }
        : { ...input, inputImages: [] };
  }

  // Job mode: submit to PGMQ and wait for worker to complete
  if (submitImageJob) {
    if (!logicalToolCallId) throw new Error("tool_call_id_required");
    lap("job_submit", { model: input.model });
    const result = generatedMediaToolResultSchema.parse(
      await submitImageJob({
        logicalToolCallId,
        prompt: input.prompt,
        title: input.title,
        model: input.model,
        aspectRatio: input.aspectRatio ?? "1:1",
        ...(input.inputImages ? { inputImages: input.inputImages } : {}),
        placement: input.placement ?? { kind: "auto_right" },
      }),
    );
    lap("job_complete", {
      jobId: result.jobId,
      attachmentStatus: result.attachmentStatus,
    });
    return result;
  }

  // Relative coordinates are resolved by the attachment transaction, so a
  // direct provider call must fail before invoking the provider.
  if (input.placement?.kind === "relative") {
    throw new RelativePlacementRequiresAttachmentBackendError();
  }

  // Direct generation: resolve provider from model ID via registry
  try {
    if (!providerRegistry) {
      throw new Error(
        "Image provider registry is required for direct generation",
      );
    }
    lap("direct_generate_start", { model: input.model });
    const providerName = providerRegistry.resolveImageProviderName(input.model);
    const result = await generateImage(providerRegistry, providerName, {
      prompt: input.prompt,
      model: input.model,
      ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
      ...(input.quality ? { quality: input.quality as any } : {}),
      ...(input.outputFormat
        ? { outputFormat: input.outputFormat as any }
        : {}),
      ...(input.inputImages?.length ? { inputImages: input.inputImages } : {}),
    });
    lap("direct_generate_done", { width: result.width, height: result.height });

    let imageUrl = result.url;
    if (persistImage) {
      try {
        imageUrl = await persistImage(
          result.url,
          result.mimeType,
          input.prompt,
        );
        lap("persist_image_done");
      } catch {
        // Fall back to ephemeral URL if upload fails
      }
    }

    const directResult: ImageGenerateResult = {
      summary: `Generated image (${result.width}x${result.height}) via ${input.model}`,
      title: input.title,
      imageUrl,
      mimeType: result.mimeType,
      width: result.width,
      height: result.height,
    };
    if (input.placement?.kind === "explicit") {
      directResult.placement = {
        x: input.placement.x,
        y: input.placement.y,
        width: input.placement.width,
        height: input.placement.height,
      };
    }
    return directResult;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
      summary: `Image generation failed: ${message}`,
      error: message,
    };
  }
}

export function createImageGenerateTool(deps?: {
  persistImage?: PersistImageFn;
  submitImageJob?: SubmitImageJobFn;
  /** Override for testing — defaults to querying the provider registry. */
  availableModels?: AvailableModel[];
  providerRegistry?: ProviderCatalog;
}) {
  const models =
    deps?.availableModels ??
    deps?.providerRegistry?.getAvailableImageModels() ??
    [];

  const modelSummary = models.length
    ? models.map((m) => `${m.displayName} (${m.id})`).join(", ")
    : "No models available";

  return tool(
    async (input: ImageGenerateInput, runtime: ToolRuntime) => {
      const attachmentMap = runtime.configurable?.user_attachment_map as
        | Record<string, string>
        | undefined;
      const result = await runImageGenerate(
        input,
        deps?.persistImage,
        deps?.submitImageJob,
        attachmentMap,
        deps?.providerRegistry,
        runtime.toolCallId ?? runtime.toolCall?.id,
      );
      if (deps?.submitImageJob) {
        const generated = generatedMediaToolResultSchema.parse(result);
        if (
          generated.attachmentStatus === "pending" ||
          generated.attachmentStatus === "not_attached"
        ) {
          throw new GeneratedAssetAttachmentError(generated);
        }
        return [generatedMediaSummary(generated), generated] as const;
      }
      return [JSON.stringify(result), result] as const;
    },
    {
      name: "generate_image",
      description: `Generate an image using AI. Available models: ${modelSummary}. Returns the generated image URL.`,
      schema: buildImageGenerateSchema(models),
      responseFormat: "content_and_artifact",
    },
  );
}
