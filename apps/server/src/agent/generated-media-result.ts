import {
  generatedAssetErrorSchema,
  generatedAssetRecoverySchema,
  toolArtifactSchema,
} from "@loomic/shared";
import { z } from "zod";

const identity = { jobId: z.string().uuid() };

const attachedSchema = z
  .object({
    attachmentStatus: z.literal("attached"),
    ...identity,
    elementId: z.string().min(1).max(256),
    canvasRevision: z.number().int().positive().safe(),
    artifact: toolArtifactSchema,
  })
  .strict();

const notRequestedSchema = z
  .object({
    attachmentStatus: z.literal("not_requested"),
    ...identity,
    artifact: toolArtifactSchema,
  })
  .strict();

const pendingSchema = z
  .object({
    attachmentStatus: z.literal("pending"),
    ...identity,
    recovery: generatedAssetRecoverySchema,
    error: generatedAssetErrorSchema,
    artifact: toolArtifactSchema.optional(),
  })
  .strict();

const notAttachedSchema = z
  .object({
    attachmentStatus: z.literal("not_attached"),
    ...identity,
    recovery: generatedAssetRecoverySchema,
    error: generatedAssetErrorSchema,
    artifact: toolArtifactSchema.optional(),
  })
  .strict();

export const generatedMediaToolResultSchema = z.discriminatedUnion(
  "attachmentStatus",
  [attachedSchema, notRequestedSchema, pendingSchema, notAttachedSchema],
);

export type GeneratedMediaToolResult = z.infer<
  typeof generatedMediaToolResultSchema
>;
export type GeneratedAssetAttachmentFailure = z.infer<
  typeof pendingSchema | typeof notAttachedSchema
>;

export class GeneratedAssetAttachmentError extends Error {
  readonly result: GeneratedAssetAttachmentFailure;

  constructor(result: GeneratedAssetAttachmentFailure) {
    const parsed = z
      .discriminatedUnion("attachmentStatus", [
        pendingSchema,
        notAttachedSchema,
      ])
      .parse(result);
    super(parsed.error.message);
    this.name = "GeneratedAssetAttachmentError";
    this.result = parsed;
  }
}

export function generatedMediaSummary(result: GeneratedMediaToolResult) {
  switch (result.attachmentStatus) {
    case "attached":
      return `Generated media was attached to the canvas as element ${result.elementId}.`;
    case "not_requested":
      return "Generated media is ready.";
    case "pending":
      return "Generated media is still being attached in the background. Do not generate it again.";
    case "not_attached":
      return "Generated media is ready but was not attached. Do not generate it again; use the recovery action.";
  }
}
