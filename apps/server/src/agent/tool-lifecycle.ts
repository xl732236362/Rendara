import { createHash } from "node:crypto";
import {
  generatedAssetRecoverySchema,
  publicToolErrorSchema,
  toolArtifactSchema,
} from "@loomic/shared";
import { z } from "zod";

const lifecycleBaseSchema = z.object({
  schemaVersion: z.literal(1),
  sequence: z.number().int().positive(),
  agentRunId: z.string().min(1),
  attemptId: z.string().min(1),
  logicalToolCallId: z.string().min(1),
  toolName: z.string().min(1),
  inputDigest: z.string().min(1),
  timestamp: z.string().datetime({ offset: true }),
});

export const canonicalToolStartedSchema = lifecycleBaseSchema
  .extend({
    type: z.literal("loomic.tool.started"),
    input: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const canonicalToolCompletedSchema = lifecycleBaseSchema
  .extend({
    type: z.literal("loomic.tool.completed"),
    output: z.record(z.string(), z.unknown()).optional(),
    outputSummary: z.string().max(512).optional(),
    artifacts: z.array(toolArtifactSchema).max(100).optional(),
  })
  .strict();

export const canonicalToolFailedSchema = lifecycleBaseSchema
  .extend({
    type: z.literal("loomic.tool.failed"),
    error: publicToolErrorSchema,
    recovery: generatedAssetRecoverySchema.optional(),
    artifacts: z.array(toolArtifactSchema).max(10).optional(),
  })
  .strict();

export const canonicalToolRecordSchema = z.discriminatedUnion("type", [
  canonicalToolStartedSchema,
  canonicalToolCompletedSchema,
  canonicalToolFailedSchema,
]);

export type CanonicalToolRecord = z.infer<typeof canonicalToolRecordSchema>;
export type CanonicalToolStarted = z.infer<typeof canonicalToolStartedSchema>;
export type CanonicalToolCompleted = z.infer<
  typeof canonicalToolCompletedSchema
>;
export type CanonicalToolFailed = z.infer<typeof canonicalToolFailedSchema>;

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function canonicalInputDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function canonicalRecordsEqual(
  left: CanonicalToolRecord,
  right: CanonicalToolRecord,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
