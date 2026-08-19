import { z } from "zod";

import { AppError, type AppErrorCode } from "../../errors/app-error.js";
import type { AdminSupabaseClient } from "../../supabase/admin.js";

const placementSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("auto_right") }).strict(),
  z
    .object({
      kind: z.literal("explicit"),
      x: z.number().finite(),
      y: z.number().finite(),
      width: z.number().finite().positive(),
      height: z.number().finite().positive(),
    })
    .strict(),
]);

const intentSchema = z
  .object({
    id: z.string().uuid(),
    job_id: z.string().uuid(),
    effect_kind: z.literal("generated_asset_attached"),
    state: z.enum([
      "pending",
      "running",
      "retry_wait",
      "attached",
      "failed",
      "canceled",
    ]),
    workspace_id: z.string().uuid(),
    project_id: z.string().uuid(),
    canvas_id: z.string().uuid(),
    session_id: z.string().uuid().nullable(),
    user_id: z.string().uuid(),
    media_type: z.enum(["image", "video"]),
    placement_policy: placementSchema,
    run_id: z.string().uuid().nullable(),
    attempt_id: z.string().uuid().nullable(),
    fencing_token: z.number().int().nonnegative().safe().nullable(),
    logical_tool_call_id: z.string().min(1).max(200).nullable(),
    input_digest: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    claim_owner: z.string().min(1).max(100).nullable(),
    claim_expires_at: z.string().datetime({ offset: true }).nullable(),
    claim_fencing_token: z.number().int().nonnegative().safe(),
    attempt_count: z.number().int().min(0).max(8),
    next_attempt_at: z.string().datetime({ offset: true }),
    result: z.record(z.string(), z.unknown()).nullable(),
    error_code: z.string().min(1).max(64).nullable(),
    created_at: z.string().datetime({ offset: true }),
    updated_at: z.string().datetime({ offset: true }),
    attached_at: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();

const attachmentReceiptSchema = z
  .object({
    attachmentStatus: z.literal("attached"),
    jobId: z.string().uuid(),
    canvasId: z.string().uuid(),
    elementId: z.string().min(1).max(256),
    canvasRevision: z.number().int().positive().safe(),
    replayed: z.boolean(),
  })
  .strict();

export type GeneratedAssetAttachmentIntent = z.infer<typeof intentSchema>;
export type GeneratedAssetAttachmentReceipt = z.infer<
  typeof attachmentReceiptSchema
>;

export type GeneratedAssetAttachmentRepository = ReturnType<
  typeof createGeneratedAssetAttachmentRepository
>;

type RpcError = {
  code?: string;
  details?: string;
  message?: string;
};

export function createGeneratedAssetAttachmentRepository(options: {
  getAdminClient(): AdminSupabaseClient;
}) {
  return {
    async claim(command: {
      workerId: string;
      limit: number;
      leaseSeconds: number;
      now: Date;
    }): Promise<GeneratedAssetAttachmentIntent[]> {
      const { data, error } = await callRpc(
        options.getAdminClient(),
        "claim_generated_asset_attachment_intents",
        {
          p_worker_id: command.workerId,
          p_limit: command.limit,
          p_lease_seconds: command.leaseSeconds,
          p_now: command.now.toISOString(),
        },
      );
      if (error) throw mapRpcError(error);
      return parseRpcResult(z.array(intentSchema), data, "intent claim");
    },

    async settle(command: {
      intentId: string;
      claimFence: number;
      outcome: "retry_wait" | "failed" | "canceled";
      errorCode: string;
      nextAttemptAt?: Date;
    }): Promise<GeneratedAssetAttachmentIntent> {
      const { data, error } = await callRpc(
        options.getAdminClient(),
        "settle_generated_asset_attachment_intent",
        {
          p_intent_id: command.intentId,
          p_claim_fence: command.claimFence,
          p_outcome: command.outcome,
          p_error_code: command.errorCode,
          p_next_attempt_at: command.nextAttemptAt?.toISOString() ?? null,
        },
      );
      if (error) throw mapRpcError(error);
      return parseRpcResult(intentSchema, data, "intent settlement");
    },

    async fulfill(command: {
      intentId: string;
      claimFence: number;
      element: Record<string, unknown>;
      file: Record<string, unknown> | null;
      agentAttemptId: string | null;
      agentFencingToken: number | null;
    }): Promise<GeneratedAssetAttachmentReceipt> {
      const { data, error } = await callRpc(
        options.getAdminClient(),
        "fulfill_generated_asset_attachment",
        {
          p_intent_id: command.intentId,
          p_claim_fence: command.claimFence,
          p_element_template: command.element,
          p_file_template: command.file,
          p_agent_attempt_id: command.agentAttemptId,
          p_agent_fencing_token: command.agentFencingToken,
        },
      );
      if (error) throw mapRpcError(error);
      return parseRpcResult(
        attachmentReceiptSchema,
        data,
        "attachment fulfillment",
      );
    },
  };
}

async function callRpc(
  client: AdminSupabaseClient,
  name: string,
  args: Record<string, unknown>,
): Promise<{ data: unknown; error: RpcError | null }> {
  return (
    client as unknown as {
      rpc(
        functionName: string,
        parameters: Record<string, unknown>,
      ): Promise<{ data: unknown; error: RpcError | null }>;
    }
  ).rpc(name, args);
}

function parseRpcResult<T>(
  schema: z.ZodType<T>,
  data: unknown,
  operation: string,
): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new AppError({
      code: "application_error",
      statusCode: 500,
      message: `Database returned an invalid ${operation} result.`,
      expose: false,
    });
  }
  return parsed.data;
}

function mapRpcError(error: RpcError): AppError {
  const mappings: Partial<
    Record<string, { code: AppErrorCode; statusCode: number }>
  > = {
    attachment_intent_not_found: {
      code: "job_not_found",
      statusCode: 404,
    },
    canvas_not_found: { code: "canvas_not_found", statusCode: 404 },
    stale_attachment_claim: {
      code: "canvas_revision_conflict",
      statusCode: 409,
    },
  };
  const mapped = error.details ? mappings[error.details] : undefined;
  const appError = new AppError({
    code: mapped?.code ?? "application_error",
    statusCode: mapped?.statusCode ?? 500,
    message: mapped
      ? "Generated asset attachment state changed."
      : "Generated asset attachment operation failed.",
    expose: false,
    cause: error,
  });
  if (error.details) {
    Object.defineProperty(appError, "attachmentErrorCode", {
      value: error.details.slice(0, 64),
      enumerable: false,
    });
  }
  return appError;
}
