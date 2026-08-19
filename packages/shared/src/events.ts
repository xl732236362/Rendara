import { z } from "zod";

import { toolArtifactSchema } from "./artifacts.js";
import {
  canvasIdSchema,
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
  videoArtifactSchema,
  placementSchema,
  toolArtifactSchema,
} from "./artifacts.js";
export type {
  ImageArtifact,
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
  artifacts: z.array(toolArtifactSchema).optional(),
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
  canvasSyncEventSchema,
  billingErrorEventSchema,
]);

export type StreamEvent = z.infer<typeof streamEventSchema>;
