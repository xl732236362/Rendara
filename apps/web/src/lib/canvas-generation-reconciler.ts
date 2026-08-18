import { z } from "zod";

import type {
  BackgroundJobStatus,
  CreateImageJobRequest,
} from "@loomic/shared";

import type { ImageGeneratorData } from "./canvas-image-generator";

export type ImageJobDisposition = "poll" | "success" | "terminal-error";

export type ImageJobResult = {
  assetId: string;
  mimeType: `image/${string}`;
  width: number;
  height: number;
};

type ImageJobContext = {
  jobId: string;
  projectId: string;
  canvasId: string;
  userId: string;
};

type ContextualJob = {
  id: string;
  project_id: string | null;
  canvas_id: string | null;
  created_by: string;
  job_type: string;
};

const imageJobResultSchema = z.object({
  asset_id: z.string().uuid(),
  mime_type: z.string().regex(/^image\/.+/),
  width: z.number().positive().finite(),
  height: z.number().positive().finite(),
});

export function buildImageJobRequest(
  data: ImageGeneratorData,
  context: { projectId: string; canvasId: string },
): CreateImageJobRequest {
  if (!data.idempotencyKey) {
    throw new Error("Image generation attempt has no idempotency key");
  }
  if (!(["standard", "hd", "ultra"] as const).includes(data.quality as never)) {
    throw new Error("Image generation attempt has an invalid quality");
  }
  return {
    idempotency_key: data.idempotencyKey,
    project_id: context.projectId,
    canvas_id: context.canvasId,
    prompt: data.prompt,
    model: data.model,
    aspect_ratio: data.aspectRatio,
    quality: data.quality as "standard" | "hd" | "ultra",
    ...(data.referenceAssetIds?.length
      ? { input_asset_ids: data.referenceAssetIds }
      : {}),
  };
}

export function classifyImageJob(input: {
  status: BackgroundJobStatus;
}): ImageJobDisposition {
  if (input.status === "succeeded") return "success";
  if (input.status === "dead_letter" || input.status === "canceled") {
    return "terminal-error";
  }
  return "poll";
}

export function validateImageJobContext(
  job: ContextualJob,
  context: ImageJobContext,
): { ok: true } | { ok: false; code: "job_context_mismatch" } {
  if (
    job.id !== context.jobId ||
    job.job_type !== "image_generation" ||
    job.project_id !== context.projectId ||
    job.canvas_id !== context.canvasId ||
    job.created_by !== context.userId
  ) {
    return { ok: false, code: "job_context_mismatch" };
  }
  return { ok: true };
}

export function parseImageJobResult(result: unknown): ImageJobResult {
  const parsed = imageJobResultSchema.safeParse(result);
  if (!parsed.success) {
    throw new Error("Invalid image job result", { cause: parsed.error });
  }
  return {
    assetId: parsed.data.asset_id,
    mimeType: parsed.data.mime_type as `image/${string}`,
    width: parsed.data.width,
    height: parsed.data.height,
  };
}
