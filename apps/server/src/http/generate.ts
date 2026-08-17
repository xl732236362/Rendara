// @credits-system — Direct generation routes with credit deduction and tier checks
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  type ImageQualityLevel,
  type VideoResolution,
  applicationErrorResponseSchema,
  unauthenticatedErrorResponseSchema,
} from "@loomic/shared";

import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { CreditService } from "../features/credits/credit-service.js";
import { CreditServiceError } from "../features/credits/credit-service.js";
import type { TierGuard } from "../features/credits/tier-guard.js";
import { TierGuardError } from "../features/credits/tier-guard.js";
import type { JobService } from "../features/jobs/job-service.js";
import { JobServiceError } from "../features/jobs/job-service.js";
import type { UploadService } from "../features/uploads/upload-service.js";
import { generateImage } from "../generation/image-generation.js";
import type { ProviderRegistry } from "../generation/providers/registry.js";
import type {
  AuthenticatedUser,
  RequestAuthenticator,
} from "../supabase/user.js";
import {
  parseRequest,
  raiseBoundaryError,
  throwLegacyServiceError,
  throwRouteError,
} from "./route-errors.js";

const generateImageRequestSchema = z.object({
  prompt: z.string().min(1),
  model: z.string().optional(),
  aspectRatio: z.enum(["1:1", "16:9", "9:16", "4:3", "3:4"]).optional(),
  quality: z.enum(["standard", "hd", "ultra"]).optional(),
});

const generateVideoRequestSchema = z.object({
  prompt: z.string().min(1),
  model: z.string().optional(),
  duration: z.number().int().min(3).max(16).optional(),
  resolution: z.enum(["720p", "1080p", "4k"]).optional(),
  aspectRatio: z.enum(["16:9", "9:16"]).optional(),
  inputImages: z.array(z.string()).max(3).optional(),
});

export async function registerGenerateRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    creditService?: CreditService;
    jobService?: JobService;
    providerRegistry: ProviderRegistry;
    tierGuard?: TierGuard;
    uploadService: UploadService;
    viewerService: ViewerService;
  },
) {
  app.post("/api/agent/generate-image", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) {
      return raiseBoundaryError(
        {
          error: {
            code: "unauthorized",
            message: "Missing or invalid bearer token.",
          },
        },
        401,
      );
    }

    const payload = parseRequest(generateImageRequestSchema, request.body);

    const model = payload.model ?? "black-forest-labs/flux-kontext-pro";

    // ── Tier guard + credit checks ──
    const viewer = await options.viewerService.ensureViewer(user);
    let creditsCost = 0;

    if (options.creditService && options.tierGuard) {
      const sub = await options.creditService.getSubscription(
        viewer.workspace.id,
      );
      const quality: ImageQualityLevel = payload.quality ?? "hd";
      options.tierGuard.checkModelAccess(sub.plan, model);
      // Throws TierGuardError (resolution_not_allowed) if plan doesn't allow this quality
      options.tierGuard.checkResolution(sub.plan, quality);
      await options.tierGuard.checkConcurrency(viewer.workspace.id, sub.plan);
      creditsCost = options.tierGuard.calculateCreditCost(
        model,
        "image_generation",
        { quality },
      );

      // Deduct credits before generation
      if (creditsCost > 0) {
        await options.creditService.deductCredits(
          viewer.workspace.id,
          user.id,
          creditsCost,
          undefined,
          `Direct image generation: ${model}`,
        );
      }
    }

    let generated: Awaited<ReturnType<typeof generateImage>>;
    try {
      const providerName =
        options.providerRegistry.resolveImageProviderName(model);
      generated = await generateImage(options.providerRegistry, providerName, {
        prompt: payload.prompt,
        model,
        aspectRatio: payload.aspectRatio ?? "1:1",
        ...(payload.quality ? { quality: payload.quality } : {}),
      });
    } catch (error) {
      const unavailable =
        error instanceof Error &&
        (error.message.includes("No provider registered") ||
          error.message.includes("No image provider registered"));
      throwRouteError({
        code: "generation_failed",
        statusCode: 502,
        message: unavailable
          ? "Image generation is unavailable."
          : "Image generation failed.",
      });
    }

    let persisted: { signedUrl: string; assetId: string };
    try {
      persisted = await downloadAndUpload(
        generated.url,
        generated.mimeType,
        payload.prompt,
        user,
        options,
      );
    } catch (error) {
      request.log.error({ err: error }, "generated image persistence failed");
      throwRouteError({
        code: "generation_failed",
        statusCode: 502,
        message: "Generated image could not be stored.",
      });
    }

    return reply.code(200).send({
      url: persisted.signedUrl,
      assetId: persisted.assetId,
      prompt: payload.prompt,
      mimeType: generated.mimeType,
      width: generated.width,
      height: generated.height,
    });
  });

  // ── POST /api/agent/generate-video ──────────────────────────
  app.post("/api/agent/generate-video", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) {
      return raiseBoundaryError(
        {
          error: {
            code: "unauthorized",
            message: "Missing or invalid bearer token.",
          },
        },
        401,
      );
    }

    const payload = parseRequest(generateVideoRequestSchema, request.body);

    if (!options.jobService) {
      return raiseBoundaryError(
        {
          error: {
            code: "service_unavailable",
            message:
              "Video generation is not available (job service not configured).",
          },
        },
        503,
      );
    }

    const model = payload.model ?? "google-official/veo-3.1-generate-preview";

    // ── Tier guard + credit checks ──
    const viewer = await options.viewerService.ensureViewer(user);
    const workspaceId = viewer.workspace.id;
    let creditsCost = 0;

    if (options.creditService && options.tierGuard) {
      const sub = await options.creditService.getSubscription(workspaceId);
      options.tierGuard.checkModelAccess(sub.plan, model);
      if (payload.resolution) {
        options.tierGuard.checkVideoResolution(
          sub.plan,
          payload.resolution as VideoResolution,
        );
      }
      await options.tierGuard.checkConcurrency(workspaceId, sub.plan);
      creditsCost = options.tierGuard.calculateCreditCost(
        model,
        "video_generation",
        {
          ...(payload.duration != null ? { duration: payload.duration } : {}),
          ...(payload.resolution
            ? { resolution: payload.resolution as VideoResolution }
            : {}),
        },
      );
    }

    // ── Create job ──
    let job: Awaited<ReturnType<JobService["createJob"]>>;
    try {
      job = await options.jobService.createJob(user, {
        workspaceId,
        jobType: "video_generation",
        payload: {
          prompt: payload.prompt,
          model,
          ...(payload.duration != null ? { duration: payload.duration } : {}),
          ...(payload.resolution ? { resolution: payload.resolution } : {}),
          ...(payload.aspectRatio ? { aspect_ratio: payload.aspectRatio } : {}),
          ...(payload.inputImages?.length
            ? { input_images: payload.inputImages }
            : {}),
        },
      });
    } catch (error) {
      request.log.error({ err: error }, "video generation job creation failed");
      if (error instanceof JobServiceError) {
        throwLegacyServiceError(error);
      }
      throwRouteError({
        code: "generation_failed",
        statusCode: 502,
        message: "Video generation could not be started.",
      });
    }

    // ── Deduct credits BEFORE generation ──
    if (options.creditService && creditsCost > 0) {
      try {
        const txId = await options.creditService.deductCredits(
          workspaceId,
          user.id,
          creditsCost,
          job.id,
          `Direct video generation: ${model}`,
        );
        await options.jobService.setCreditsInfo(job.id, creditsCost, txId);
      } catch (deductError) {
        await options.jobService.cancelJob(user, job.id).catch(() => {});
        throw deductError;
      }
    }

    // ── Poll until terminal state ──
    const POLL_INTERVAL = 3_000;
    const MAX_WAIT = 300_000; // 5 minutes

    let result: PollResult;
    try {
      result = await pollJobUntilDone(
        options.jobService,
        job.id,
        POLL_INTERVAL,
        MAX_WAIT,
      );
    } catch (error) {
      request.log.error({ err: error }, "video generation job polling failed");
      if (error instanceof JobServiceError) {
        throwLegacyServiceError(error);
      }
      throwRouteError({
        code: "generation_failed",
        statusCode: 502,
        message: "Video generation status could not be retrieved.",
      });
    }

    if ("error" in result) {
      return raiseBoundaryError(
        {
          error: {
            code: "generation_failed",
            message: "Video generation failed.",
          },
        },
        502,
      );
    }

    return reply.code(200).send({
      url: result.signed_url,
      assetId: result.asset_id,
      prompt: payload.prompt,
      mimeType: result.mime_type,
      width: result.width,
      height: result.height,
      durationSeconds: result.duration_seconds,
    });
  });
}

// ── Job polling helper ──────────────────────────────────────

type VideoJobResult = {
  signed_url: string;
  asset_id: string;
  width: number;
  height: number;
  duration_seconds: number;
  mime_type: string;
};

type PollResult = VideoJobResult | { error: string };

async function pollJobUntilDone(
  jobService: JobService,
  jobId: string,
  pollInterval: number,
  maxWait: number,
): Promise<PollResult> {
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    await delay(pollInterval);

    const current = await jobService.getJobAdmin(jobId);

    if (current.status === "succeeded" && current.result) {
      const r = current.result as Record<string, unknown>;
      return {
        signed_url: (r.signed_url as string) ?? "",
        asset_id: (r.asset_id as string) ?? "",
        width: (r.width as number) ?? 0,
        height: (r.height as number) ?? 0,
        duration_seconds: (r.duration_seconds as number) ?? 0,
        mime_type: (r.mime_type as string) ?? "video/mp4",
      };
    }

    if (current.status === "dead_letter" || current.status === "canceled") {
      return { error: current.error_message ?? `Job ${current.status}` };
    }

    if (
      current.status === "failed" &&
      current.attempt_count >= current.max_attempts
    ) {
      return {
        error: current.error_message ?? "Job failed after max retries",
      };
    }
  }

  return { error: `Job timed out after ${maxWait / 1000}s` };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Image download + upload helper ──────────────────────────

async function downloadAndUpload(
  sourceUrl: string,
  mimeType: string,
  prompt: string,
  user: AuthenticatedUser,
  deps: { uploadService: UploadService; viewerService: ViewerService },
): Promise<{ signedUrl: string; assetId: string }> {
  const response = await fetch(sourceUrl);
  if (!response.ok) {
    throw new Error(`Failed to download generated image: ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());

  const ext = mimeType === "image/webp" ? "webp" : "png";
  const slug = prompt
    .slice(0, 40)
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const fileName = `gen-${slug}-${Date.now()}.${ext}`;

  const viewer = await deps.viewerService.ensureViewer(user);

  const result = await deps.uploadService.uploadFile(user, {
    bucket: "project-assets",
    fileName,
    fileBuffer: buffer,
    mimeType,
    workspaceId: viewer.workspace.id,
  });

  return { signedUrl: result.url, assetId: result.asset.id };
}
