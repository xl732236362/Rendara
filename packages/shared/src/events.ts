import { z } from "zod";

import {
  boundedToolArtifactsSchema,
  generatedAssetRecoverySchema,
  toolArtifactsSchema,
} from "./artifacts.js";
import {
  canvasIdSchema,
  contentBlockSchema,
  conversationIdSchema,
  identifierSchema,
  messageIdSchema,
  runIdSchema,
  sessionIdSchema,
  timestampSchema,
  toolCallIdSchema,
} from "./contracts.js";
import { loomicErrorSchema } from "./errors.js";

export {
  imageArtifactSchema,
  imageArtifactSourceSchema,
  videoArtifactSchema,
  placementSchema,
  generatedAssetAttachmentStatusSchema,
  generatedAssetErrorSchema,
  generatedAssetRecoverySchema,
  boundedToolArtifactsSchema,
  toolArtifactSchema,
  toolArtifactsSchema,
} from "./artifacts.js";
export type {
  GeneratedAssetAttachmentStatus,
  GeneratedAssetError,
  GeneratedAssetRecovery,
  ImageArtifact,
  ImageArtifactSource,
  VideoArtifact,
  Placement,
  ToolArtifact,
} from "./artifacts.js";

export const runStartedEventSchema = z.object({
  type: z.literal("run.started"),
  runId: runIdSchema,
  sessionId: sessionIdSchema,
  conversationId: conversationIdSchema,
  timestamp: timestampSchema,
});

export const messageDeltaEventSchema = z.object({
  type: z.literal("message.delta"),
  runId: runIdSchema,
  messageId: messageIdSchema,
  delta: z.string(),
  timestamp: timestampSchema,
});

export const toolStartedEventSchema = z.object({
  type: z.literal("tool.started"),
  runId: runIdSchema,
  toolCallId: toolCallIdSchema,
  toolName: z.string().min(1),
  input: z.record(z.string(), z.unknown()).optional(),
  timestamp: timestampSchema,
});

export const toolCompletedEventSchema = z.object({
  type: z.literal("tool.completed"),
  runId: runIdSchema,
  toolCallId: toolCallIdSchema,
  toolName: z.string().min(1),
  output: z.record(z.string(), z.unknown()).optional(),
  outputSummary: z.string().optional(),
  artifacts: toolArtifactsSchema.optional(),
  timestamp: timestampSchema,
});

export const publicToolErrorSchema = z
  .object({
    code: z.string().min(1).max(64),
    message: z.string().min(1).max(512),
    correlationId: identifierSchema,
  })
  .strict();

export const toolFailedEventSchema = z.object({
  type: z.literal("tool.failed"),
  runId: runIdSchema,
  toolCallId: toolCallIdSchema,
  toolName: z.string().min(1),
  error: publicToolErrorSchema,
  recovery: generatedAssetRecoverySchema.optional(),
  artifacts: boundedToolArtifactsSchema(10).optional(),
  timestamp: timestampSchema,
});

export const runCompletedEventSchema = z.object({
  type: z.literal("run.completed"),
  runId: runIdSchema,
  timestamp: timestampSchema,
});

export const runCanceledEventSchema = z.object({
  type: z.literal("run.canceled"),
  runId: runIdSchema,
  timestamp: timestampSchema,
});

export const runFailedEventSchema = z.object({
  type: z.literal("run.failed"),
  runId: runIdSchema,
  error: loomicErrorSchema,
  timestamp: timestampSchema,
});

/**
 * Durable notice that the completed Agent response could not be persisted.
 * This is separate from run.failed because the Agent run itself may succeed.
 */
export const assistantPersistenceFailedEventSchema = z.object({
  type: z.literal("assistant.persistence_failed"),
  runId: runIdSchema,
  // Present for new server events. Optional keeps older unbuffered transports
  // readable, but clients must not recover a remounted response without it.
  sessionId: sessionIdSchema.optional(),
  assistant: z
    .object({
      content: z.string().max(16_000),
      contentBlocks: z.array(contentBlockSchema).max(32),
    })
    .optional(),
  timestamp: timestampSchema,
});

export const thinkingDeltaEventSchema = z.object({
  type: z.literal("thinking.delta"),
  runId: runIdSchema,
  messageId: messageIdSchema,
  delta: z.string(),
  timestamp: timestampSchema,
});

export const canvasSyncEventSchema = z.object({
  type: z.literal("canvas.sync"),
  eventId: identifierSchema,
  canvasId: canvasIdSchema,
  revision: z.number().int().positive().safe(),
  timestamp: timestampSchema,
});

export const billingErrorCodeSchema = z.enum([
  "insufficient_credits",
  "model_not_accessible",
  "resolution_not_allowed",
  "concurrency_limit",
]);

export type BillingErrorCode = z.infer<typeof billingErrorCodeSchema>;

export const billingErrorEventSchema = z.object({
  type: z.literal("billing.error"),
  runId: runIdSchema,
  timestamp: timestampSchema,
  code: billingErrorCodeSchema,
  message: z.string(),
  // Credits-specific (only for insufficient_credits)
  currentBalance: z.number().optional(),
  requiredAmount: z.number().optional(),
  plan: z.string().optional(),
  dailyClaimed: z.boolean().optional(),
});

export const streamEventSchema = z.discriminatedUnion("type", [
  runStartedEventSchema,
  messageDeltaEventSchema,
  thinkingDeltaEventSchema,
  toolStartedEventSchema,
  toolCompletedEventSchema,
  toolFailedEventSchema,
  runCanceledEventSchema,
  runCompletedEventSchema,
  runFailedEventSchema,
  assistantPersistenceFailedEventSchema,
  canvasSyncEventSchema,
  billingErrorEventSchema,
]);

export type StreamEvent = z.infer<typeof streamEventSchema>;
