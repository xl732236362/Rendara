import { z } from "zod";

export const placementSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
});

const safeArtifactUrlSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      value.startsWith("https://") || value.startsWith("/api/assets/"),
    { message: "Artifact URL must use HTTPS or an authenticated asset route." },
  );

export const imageArtifactSchema = z.object({
  type: z.literal("image"),
  title: z.string().optional(),
  url: safeArtifactUrlSchema,
  mimeType: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  placement: placementSchema.optional(),
  jobId: z.string().optional(),
});

export const videoArtifactSchema = z.object({
  type: z.literal("video"),
  title: z.string().optional(),
  url: safeArtifactUrlSchema,
  mimeType: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  durationSeconds: z.number().optional(),
  placement: placementSchema.optional(),
  jobId: z.string().optional(),
});

export const toolArtifactSchema = z.discriminatedUnion("type", [
  imageArtifactSchema,
  videoArtifactSchema,
]);

export const generatedAssetRecoverySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("attach_generated_asset"),
      jobId: z.string().uuid(),
      canvasId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("watch_generated_asset"),
      jobId: z.string().uuid(),
      canvasId: z.string().uuid(),
    })
    .strict(),
]);

export const generatedAssetErrorSchema = z
  .object({
    code: z.string().min(1).max(64),
    message: z.string().min(1).max(512),
    retryable: z.boolean(),
  })
  .strict();

const attachmentIdentityShape = {
  jobId: z.string().uuid(),
};

export const generatedAssetAttachmentStatusSchema = z.discriminatedUnion(
  "attachmentStatus",
  [
    z
      .object({
        attachmentStatus: z.literal("attached"),
        ...attachmentIdentityShape,
        elementId: z.string().min(1).max(256),
        canvasRevision: z.number().int().positive().safe(),
      })
      .strict(),
    z
      .object({
        attachmentStatus: z.literal("not_requested"),
        ...attachmentIdentityShape,
      })
      .strict(),
    z
      .object({
        attachmentStatus: z.literal("pending"),
        ...attachmentIdentityShape,
        recovery: generatedAssetRecoverySchema,
        error: generatedAssetErrorSchema,
      })
      .strict(),
    z
      .object({
        attachmentStatus: z.literal("not_attached"),
        ...attachmentIdentityShape,
        recovery: generatedAssetRecoverySchema,
        error: generatedAssetErrorSchema,
      })
      .strict(),
  ],
);

export type Placement = z.infer<typeof placementSchema>;
export type ImageArtifact = z.infer<typeof imageArtifactSchema>;
export type VideoArtifact = z.infer<typeof videoArtifactSchema>;
export type ToolArtifact = z.infer<typeof toolArtifactSchema>;
export type GeneratedAssetRecovery = z.infer<
  typeof generatedAssetRecoverySchema
>;
export type GeneratedAssetError = z.infer<typeof generatedAssetErrorSchema>;
export type GeneratedAssetAttachmentStatus = z.infer<
  typeof generatedAssetAttachmentStatusSchema
>;
