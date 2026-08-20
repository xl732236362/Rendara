import type { ToolRuntime } from "@langchain/core/tools";
import { tool } from "langchain";
import { z } from "zod";

import type {
  AvailableModel,
  ProviderCatalog,
} from "../../generation/providers/registry.js";
import { generateVideo } from "../../generation/video-generation.js";
import {
  GeneratedAssetAttachmentError,
  type GeneratedMediaToolResult,
  generatedMediaSummary,
  generatedMediaToolResultSchema,
} from "../generated-media-result.js";

const DEFAULT_MODEL = "wan-video/wan-2.6";

// ── Submit function type ───────────────────────────────────────────────────

export type SubmitVideoJobFn = (input: {
  logicalToolCallId: string;
  prompt: string;
  model: string;
  duration?: number;
  resolution?: string;
  aspectRatio?: string;
  inputImages?: string[];
  inputVideo?: string;
  enableAudio?: boolean;
}) => Promise<GeneratedMediaToolResult>;

// ── Dynamic schema builder ─────────────────────────────────────────────────

function buildVideoGenerateSchema(models: AvailableModel[]) {
  const modelIds = models.map((m) => m.id);
  const defaultModel = modelIds.includes(DEFAULT_MODEL)
    ? DEFAULT_MODEL
    : (modelIds[0] ?? DEFAULT_MODEL);

  const modelDescription = models.length
    ? `Video model to use. Available:\n${models.map((m) => `- ${m.id}: ${m.description}`).join("\n")}`
    : "Model identifier (no video providers currently registered)";

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
          "Short descriptive title for the generated video, used as metadata so the video content is understood without re-analysis (e.g. 'Autumn forest bus scene', '恐龙追逐镜头')",
        ),
      prompt: z
        .string()
        .min(1)
        .describe(
          "Detailed video generation prompt. Be specific about motion, camera angles, lighting, mood, action, and scene transitions.",
        ),
      model: modelField,
      duration: z
        .number()
        .int()
        .min(3)
        .max(16)
        .optional()
        .default(5)
        .describe(
          "Video duration in seconds. Valid range depends on model (see model descriptions). Google Veo supports 4/6/8, Replicate models support 3-16.",
        ),
      resolution: z
        .enum(["480p", "720p", "1080p", "4k"])
        .optional()
        .default("720p")
        .describe(
          "Output resolution. 720p recommended for balance of quality and speed. 1080p/4k supported by Google Veo official models (8s duration required).",
        ),
      aspectRatio: z
        .enum(["1:1", "16:9", "9:16", "4:3", "3:4"])
        .optional()
        .default("16:9")
        .describe(
          "Video aspect ratio. 16:9 for landscape, 9:16 for portrait/mobile.",
        ),
      inputImages: z
        .array(opaqueMediaIdSchema)
        .max(7)
        .optional()
        .describe("Authorized reference image asset IDs for image-to-video."),
      inputVideo: opaqueMediaIdSchema
        .optional()
        .describe(
          "Authorized source video asset ID for video-to-video editing.",
        ),
      enableAudio: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          "Generate synchronized audio (dialogue, sound effects, ambient). Not all models support this — ignored for models without audio capability.",
        ),
      placementX: z
        .number()
        .optional()
        .describe(
          "Canvas X coordinate for video placement. Use inspect_canvas to find a good position.",
        ),
      placementY: z
        .number()
        .optional()
        .describe(
          "Canvas Y coordinate for video placement. Use inspect_canvas to find a good position.",
        ),
      placementWidth: z
        .number()
        .optional()
        .describe("Width on canvas (default: 640)"),
      placementHeight: z
        .number()
        .optional()
        .describe("Height on canvas (default: 360)"),
    })
    .strict();
}

const opaqueMediaIdSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !/^(?:https?:|data:|file:)/i.test(value), {
    message: "raw_url_not_allowed",
  });

// ── Result type ────────────────────────────────────────────────────────────

// Infer input type from schema — includes the new `title` field
type VideoGenerateInput = z.infer<ReturnType<typeof buildVideoGenerateSchema>>;

type VideoGenerateResult = {
  summary: string;
  title?: string;
  prompt?: string;
  elementId?: string;
  videoUrl?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  placement?: { x: number; y: number; width: number; height: number };
  error?: string;
  jobId?: string;
  jobType?: "video_generation";
};

// ── Run function ───────────────────────────────────────────────────────────

export async function runVideoGenerate(
  input: VideoGenerateInput,
  submitVideoJob?: SubmitVideoJobFn,
  providerRegistry?: ProviderCatalog,
  logicalToolCallId?: string,
): Promise<VideoGenerateResult | GeneratedMediaToolResult> {
  const t0 = Date.now();
  const lap = (label: string, extra?: Record<string, unknown>) => {
    console.log(
      `[generate_video] ${label} +${Date.now() - t0}ms`,
      extra ? JSON.stringify(extra) : "",
    );
  };

  // Filter invalid image references
  if (input.inputImages?.length) {
    const validImages = input.inputImages.filter(
      (img) =>
        img.startsWith("http://") ||
        img.startsWith("https://") ||
        img.startsWith("data:"),
    );
    input = {
      ...input,
      inputImages: validImages.length > 0 ? validImages : undefined,
    };
  }

  // Job mode: submit to PGMQ and wait for worker
  if (submitVideoJob) {
    if (!logicalToolCallId) throw new Error("tool_call_id_required");
    lap("job_submit", { model: input.model });
    const result = generatedMediaToolResultSchema.parse(
      await submitVideoJob({
        logicalToolCallId,
        prompt: input.prompt,
        model: input.model,
        duration: input.duration,
        resolution: input.resolution,
        aspectRatio: input.aspectRatio,
        ...(input.inputImages ? { inputImages: input.inputImages } : {}),
        ...(input.inputVideo ? { inputVideo: input.inputVideo } : {}),
        enableAudio: input.enableAudio,
      }),
    );
    lap("job_complete", {
      jobId: result.jobId,
      attachmentStatus: result.attachmentStatus,
    });
    return result;
  }

  // Direct mode: call provider directly
  try {
    if (!providerRegistry) {
      throw new Error(
        "Video provider registry is required for direct generation",
      );
    }
    lap("direct_generate_start", { model: input.model });
    const providerName = providerRegistry.resolveVideoProviderName(input.model);
    const result = await generateVideo(providerRegistry, providerName, {
      prompt: input.prompt,
      model: input.model,
      duration: input.duration,
      aspectRatio: input.aspectRatio,
      ...(input.resolution
        ? { resolution: input.resolution as "480p" | "720p" | "1080p" }
        : {}),
      ...(input.inputImages ? { inputImages: input.inputImages } : {}),
      ...(input.inputVideo ? { inputVideo: input.inputVideo } : {}),
      ...(input.enableAudio != null ? { enableAudio: input.enableAudio } : {}),
    });
    lap("direct_generate_done");

    const directResult: VideoGenerateResult = {
      summary: `Generated ${result.durationSeconds}s video (${result.width}x${result.height}) via ${input.model}`,
      title: input.title,
      prompt: input.prompt,
      videoUrl: result.url,
      mimeType: result.mimeType,
      width: result.width,
      height: result.height,
      durationSeconds: result.durationSeconds,
    };
    if (input.placementX != null && input.placementY != null) {
      directResult.placement = {
        x: input.placementX,
        y: input.placementY,
        width: input.placementWidth ?? 640,
        height: input.placementHeight ?? 360,
      };
    }
    return directResult;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
      summary: `Video generation failed: ${message}`,
      error: message,
    };
  }
}

// ── Tool factory ───────────────────────────────────────────────────────────

export function createVideoGenerateTool(deps?: {
  submitVideoJob?: SubmitVideoJobFn;
  availableModels?: AvailableModel[];
  providerRegistry?: ProviderCatalog;
}) {
  const models =
    deps?.availableModels ??
    deps?.providerRegistry?.getAvailableVideoModels() ??
    [];

  const modelSummary = models.length
    ? models.map((m) => `${m.displayName} (${m.id})`).join(", ")
    : "No video models available";

  return tool(
    async (input: VideoGenerateInput, runtime: ToolRuntime) => {
      const result = await runVideoGenerate(
        input,
        deps?.submitVideoJob,
        deps?.providerRegistry,
        runtime.toolCallId ?? runtime.toolCall?.id,
      );
      if (deps?.submitVideoJob) {
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
      name: "generate_video",
      description: `Generate a video using AI. Available models: ${modelSummary}. Supports text-to-video, image-to-video, and video editing. Returns the generated video URL.`,
      schema: buildVideoGenerateSchema(models),
      responseFormat: "content_and_artifact",
    },
  );
}
