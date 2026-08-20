import { createHash } from "node:crypto";
import { z } from "zod";

import type { AttachGeneratedAssetCommand } from "../../application/canvas/attach-generated-asset.js";
import type { GeneratedAssetAttachmentRecovery } from "../../application/canvas/attach-generated-asset.js";
import type { AdminSupabaseClient } from "../../supabase/admin.js";
import type { UserSupabaseClient } from "../../supabase/user.js";
import {
  insertImageElement,
  insertVideoElement,
  prepareImageDataURL,
} from "./canvas-element-writer.js";
import { createCanvasRepository } from "./canvas-repository.js";
import type { GeneratedAssetAttachmentPreparation } from "./generated-asset-attachment-reconciler.js";
import type { GeneratedAssetAttachmentIntent } from "./generated-asset-attachment-repository.js";
import { createGeneratedAssetAttachmentRepository } from "./generated-asset-attachment-repository.js";

export function createGeneratedAssetAttachmentRecoveryPort(options: {
  getAdminClient(): AdminSupabaseClient;
}): GeneratedAssetAttachmentRecovery {
  const repository = createGeneratedAssetAttachmentRepository(options);
  return {
    getStatus(principal, command) {
      return repository.getStatus({ ...principal, ...command });
    },
    listOutstanding(principal, command) {
      return repository.listOutstanding({
        ...principal,
        ...command,
        limit: 100,
      });
    },
    retry(principal, command) {
      return repository.retry({ ...principal, ...command });
    },
  };
}

const sourceJobSchema = z.object({
  id: z.string().uuid(),
  status: z.enum([
    "queued",
    "running",
    "failed",
    "cancel_requested",
    "succeeded",
    "dead_letter",
    "canceled",
  ]),
  job_type: z.enum(["image_generation", "video_generation"]).optional(),
  workspace_id: z.string().uuid().optional(),
  project_id: z.string().uuid().nullable().optional(),
  canvas_id: z.string().uuid().nullable().optional(),
  session_id: z.string().uuid().nullable().optional(),
  created_by: z.string().uuid().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  result: z.record(z.string(), z.unknown()).nullable().optional(),
});

const sourceAssetSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  project_id: z.string().uuid(),
  generation_job_id: z.string().uuid(),
  mime_type: z.string().min(1).max(255),
});

const elementTemplateSchema = z
  .object({
    id: z.string().uuid(),
    type: z.enum(["image", "embeddable"]),
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
    angle: z.literal(0),
    strokeColor: z.string(),
    backgroundColor: z.string(),
    fillStyle: z.literal("solid"),
    strokeWidth: z.literal(1),
    strokeStyle: z.literal("solid"),
    roughness: z.literal(0),
    opacity: z.literal(100),
    groupIds: z.array(z.string()).max(20),
    roundness: z.null(),
    boundElements: z.null(),
    frameId: z.null(),
    index: z.null(),
    seed: z.number().int().nonnegative(),
    version: z.literal(1),
    versionNonce: z.number().int().nonnegative(),
    isDeleted: z.literal(false),
    updated: z.number().int().nonnegative(),
    link: z.string().nullable(),
    locked: z.literal(false),
    fileId: z.string().optional(),
    status: z.literal("saved").optional(),
    scale: z.tuple([z.literal(1), z.literal(1)]).optional(),
    crop: z.null().optional(),
    customData: z.record(z.string(), z.unknown()),
  })
  .strict();

const fileTemplateSchema = z
  .object({
    id: z.string().min(1).max(256),
    assetId: z.string().uuid(),
    mimeType: z.string().min(1).max(255),
    created: z.number().int().nonnegative(),
  })
  .strict();

export function createGeneratedAssetPort(options: {
  createUserClient(accessToken: string): UserSupabaseClient;
  getAdminClient(): AdminSupabaseClient;
}) {
  const repository = createCanvasRepository(options);
  return {
    async attach(command: AttachGeneratedAssetCommand) {
      const user = {
        id: command.principal.userId,
        accessToken: command.principal.accessToken ?? "",
        email: "",
        userMetadata: {},
      };
      const client = options.createUserClient(user.accessToken);
      const imageDataURL =
        command.asset.type === "image"
          ? await prepareImageDataURL(
              client,
              command.asset.objectPath,
              command.asset.mimeType,
            )
          : undefined;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const canvas = await repository.read(user, command.canvasId);
        const inserted =
          command.asset.type === "image"
            ? insertImageElement(
                canvas.content,
                {
                  dataURL: imageDataURL!,
                  elementId: command.jobId,
                  fileId: `${command.jobId}-file`,
                  width: command.asset.width,
                  height: command.asset.height,
                  mimeType: command.asset.mimeType,
                  ...(command.asset.title
                    ? { title: command.asset.title }
                    : {}),
                },
                command.placement,
              )
            : insertVideoElement(
                canvas.content,
                {
                  signedUrl: command.asset.signedUrl,
                  elementId: command.jobId,
                  width: command.asset.width,
                  height: command.asset.height,
                  mimeType: command.asset.mimeType,
                  ...(command.asset.durationSeconds !== undefined
                    ? { durationSeconds: command.asset.durationSeconds }
                    : {}),
                },
                command.placement,
              );
        try {
          const committed = await repository.commit(user, {
            canvasId: command.canvasId,
            expectedRevision: canvas.revision,
            content: inserted.content,
            jobId: command.jobId,
            effectKind: command.effectKey,
            ...(command.agentEffect
              ? {
                  agentEffect: {
                    ...command.agentEffect,
                    result: command.agentEffect.result ?? {
                      elementId: inserted.elementId,
                    },
                  },
                }
              : {}),
          });
          return {
            elementId: inserted.elementId,
            replayed: committed.replayed,
          };
        } catch (error) {
          if (!isConflict(error) || attempt === 3) throw error;
        }
      }
      throw new Error("Generated asset Canvas commit retry exhausted.");
    },
  };
}

export function createGeneratedAssetAttachmentTemplateAdapter(options: {
  getAdminClient(): AdminSupabaseClient;
  now?: () => Date;
}) {
  const now = options.now ?? (() => new Date());
  return {
    async prepare(
      intent: GeneratedAssetAttachmentIntent,
    ): Promise<GeneratedAssetAttachmentPreparation> {
      const job = await readJob(options.getAdminClient(), intent.job_id);
      if (job.status === "canceled") {
        return {
          kind: "terminal_without_asset",
          outcome: "canceled",
          errorCode: "generation_canceled",
        };
      }
      if (job.status === "dead_letter") {
        return {
          kind: "terminal_without_asset",
          outcome: "failed",
          errorCode: "generation_dead_lettered",
        };
      }
      if (job.status !== "succeeded") {
        throw attachmentError(
          "generation_not_terminal",
          "Generation job is not terminal.",
        );
      }
      assertJobScope(job, intent);
      const result = job.result;
      const assetId = result?.asset_id;
      if (
        typeof assetId !== "string" ||
        !z.string().uuid().safeParse(assetId).success
      ) {
        throw attachmentError(
          "attachment_integrity_failure",
          "Generated job has no valid asset identity.",
        );
      }
      const asset = await readAsset(options.getAdminClient(), {
        assetId,
        intent,
      });
      const expectedMimePrefix =
        intent.media_type === "image" ? "image/" : "video/";
      if (!asset.mime_type.startsWith(expectedMimePrefix)) {
        throw attachmentError(
          "attachment_integrity_failure",
          "Generated asset media type does not match its intent.",
        );
      }
      const dimensions = templateDimensions(intent, result);
      const base = buildBaseElement(intent.job_id, dimensions, now());
      if (intent.media_type === "image") {
        const fileId = `${intent.job_id}-file`;
        return {
          kind: "ready",
          element: elementTemplateSchema.parse({
            ...base,
            type: "image",
            fileId,
            status: "saved",
            scale: [1, 1],
            crop: null,
            customData: { source: "generated" },
          }),
          file: fileTemplateSchema.parse({
            id: fileId,
            assetId: asset.id,
            mimeType: asset.mime_type,
            created: now().getTime(),
          }),
        };
      }
      return {
        kind: "ready",
        element: elementTemplateSchema.parse({
          ...base,
          type: "embeddable",
          link: `/api/assets/${asset.id}`,
          customData: {
            assetId: asset.id,
            isVideo: true,
            mimeType: asset.mime_type,
            ...(typeof result?.duration_seconds === "number" &&
            Number.isFinite(result.duration_seconds) &&
            result.duration_seconds >= 0
              ? { durationSeconds: result.duration_seconds }
              : {}),
          },
        }),
        file: null,
      };
    },
  };
}

async function readJob(client: AdminSupabaseClient, jobId: string) {
  const { data, error } = await client
    .from("background_jobs")
    .select(
      "id,status,job_type,workspace_id,project_id,canvas_id,session_id,created_by,payload,result",
    )
    .eq("id", jobId)
    .maybeSingle();
  if (error || !data) {
    throw attachmentError(
      error
        ? "attachment_infrastructure_error"
        : "attachment_integrity_failure",
      "Generated job could not be loaded.",
    );
  }
  const parsed = sourceJobSchema.safeParse(data);
  if (!parsed.success) {
    throw attachmentError(
      "attachment_integrity_failure",
      "Generated job data is invalid.",
    );
  }
  return parsed.data;
}

async function readAsset(
  client: AdminSupabaseClient,
  options: { assetId: string; intent: GeneratedAssetAttachmentIntent },
) {
  const { data, error } = await client
    .from("asset_objects")
    .select("id,workspace_id,project_id,generation_job_id,mime_type")
    .eq("id", options.assetId)
    .eq("generation_job_id", options.intent.job_id)
    .eq("workspace_id", options.intent.workspace_id)
    .eq("project_id", options.intent.project_id)
    .maybeSingle();
  if (error || !data) {
    throw attachmentError(
      error
        ? "attachment_infrastructure_error"
        : "attachment_integrity_failure",
      "Generated asset could not be loaded.",
    );
  }
  const parsed = sourceAssetSchema.safeParse(data);
  if (!parsed.success) {
    throw attachmentError(
      "attachment_integrity_failure",
      "Generated asset data is invalid.",
    );
  }
  return parsed.data;
}

function assertJobScope(
  job: z.infer<typeof sourceJobSchema>,
  intent: GeneratedAssetAttachmentIntent,
): void {
  if (
    job.id !== intent.job_id ||
    job.workspace_id !== intent.workspace_id ||
    job.project_id !== intent.project_id ||
    job.canvas_id !== intent.canvas_id ||
    job.session_id !== intent.session_id ||
    job.created_by !== intent.user_id ||
    (intent.media_type === "image" && job.job_type !== "image_generation") ||
    (intent.media_type === "video" && job.job_type !== "video_generation")
  ) {
    throw attachmentError(
      "attachment_integrity_failure",
      "Generated job scope does not match its attachment intent.",
    );
  }
}

function templateDimensions(
  intent: GeneratedAssetAttachmentIntent,
  result: Record<string, unknown> | null | undefined,
) {
  if (intent.placement_policy.kind === "explicit") {
    return intent.placement_policy;
  }
  const width = positiveDimension(result?.width);
  const height = positiveDimension(result?.height);
  const maxWidth =
    intent.placement_policy.kind === "relative"
      ? (intent.placement_policy.maxWidth ?? 600)
      : intent.media_type === "image"
        ? 600
        : 800;
  const maxHeight =
    intent.placement_policy.kind === "relative"
      ? (intent.placement_policy.maxHeight ?? 600)
      : intent.media_type === "image"
        ? 600
        : 800;
  const ratio = Math.min(1, maxWidth / width, maxHeight / height);
  return {
    x: 0,
    y: 0,
    width: Math.round(width * ratio),
    height: Math.round(height * ratio),
  };
}

function positiveDimension(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw attachmentError(
      "attachment_integrity_failure",
      "Generated asset dimensions are invalid.",
    );
  }
  return value;
}

function buildBaseElement(
  jobId: string,
  placement: { x: number; y: number; width: number; height: number },
  timestamp: Date,
) {
  const digest = createHash("sha256").update(jobId).digest();
  return {
    id: jobId,
    x: placement.x,
    y: placement.y,
    width: placement.width,
    height: placement.height,
    angle: 0 as const,
    strokeColor: "#000000",
    backgroundColor: "transparent",
    fillStyle: "solid" as const,
    strokeWidth: 1 as const,
    strokeStyle: "solid" as const,
    roughness: 0 as const,
    opacity: 100 as const,
    groupIds: [],
    roundness: null,
    boundElements: null,
    frameId: null,
    index: null,
    seed: digest.readUInt32BE(0) & 0x7fffffff,
    version: 1 as const,
    versionNonce: digest.readUInt32BE(4) & 0x7fffffff,
    isDeleted: false as const,
    updated: timestamp.getTime(),
    link: null,
    locked: false as const,
  };
}

function attachmentError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function isConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { code?: unknown }).code === "canvas_revision_conflict"
  );
}
