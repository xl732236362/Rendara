import { backgroundJobSchema, type BackgroundJob } from "@loomic/shared";
import { z } from "zod";

import type { AtomicJobSubmissionCommand } from "../../application/generation/ports.js";
import { AppError, type AppErrorCode } from "../../errors/app-error.js";
import type { AdminSupabaseClient } from "../../supabase/admin.js";
import type {
  AuthenticatedUser,
  UserSupabaseClient,
} from "../../supabase/user.js";

const atomicSubmissionSchema = z.object({
  job: backgroundJobSchema,
  debit_transaction_id: z.string().uuid().nullable(),
  replayed: z.boolean(),
});

const cancellationSchema = z.object({
  job: backgroundJobSchema,
  replayed: z.boolean(),
});

type RpcError = {
  code?: string;
  details?: string;
  hint?: string;
  message?: string;
};

export type AtomicSubmissionResult = {
  job: BackgroundJob;
  debitTransactionId: string | null;
  replayed: boolean;
};

export type JobStateRepository = {
  submit(
    user: AuthenticatedUser,
    command: Omit<AtomicJobSubmissionCommand, "principal">,
  ): Promise<AtomicSubmissionResult>;
  requestCancellation(
    user: AuthenticatedUser,
    jobId: string,
  ): Promise<{ job: BackgroundJob; replayed: boolean }>;
};

export function createJobStateRepository(options: {
  createUserClient(accessToken: string): UserSupabaseClient;
  getAdminClient(): AdminSupabaseClient;
}): JobStateRepository {
  return {
    async submit(user, command) {
      const { data, error } = await callRpc(
        options.getAdminClient(),
        "submit_generation_job",
        {
          p_workspace_id: command.workspaceId,
          p_user_id: user.id,
          p_idempotency_key: command.idempotencyKey,
          p_request_fingerprint: command.requestFingerprint,
          p_job_type: command.jobType,
          p_payload: command.payload,
          p_credits_cost: command.creditsCost,
          p_description: command.description,
          p_project_id: command.projectId ?? null,
          p_canvas_id: command.canvasId ?? null,
          p_session_id: command.sessionId ?? null,
          p_thread_id: command.threadId ?? null,
        },
      );
      if (error) throw mapRpcError(error, "job_create_failed");
      const parsed = atomicSubmissionSchema.safeParse(data);
      if (!parsed.success) throw invalidRpcResult("generation submission");
      return {
        job: parsed.data.job,
        debitTransactionId: parsed.data.debit_transaction_id,
        replayed: parsed.data.replayed,
      };
    },

    async requestCancellation(user, jobId) {
      const client = options.createUserClient(user.accessToken);
      const { data, error } = await callRpc(
        client,
        "request_generation_cancellation",
        { p_job_id: jobId },
      );
      if (error) throw mapRpcError(error, "job_cancel_failed");
      const parsed = cancellationSchema.safeParse(data);
      if (!parsed.success) throw invalidRpcResult("generation cancellation");
      return parsed.data;
    },
  };
}

async function callRpc(
  client: AdminSupabaseClient | UserSupabaseClient,
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

function mapRpcError(error: RpcError, fallback: AppErrorCode): AppError {
  const detail = error.details;
  const mapped: Partial<
    Record<string, { code: AppErrorCode; status: number }>
  > = {
    canvas_not_found: { code: "canvas_not_found", status: 404 },
    forbidden: { code: "forbidden", status: 403 },
    idempotency_conflict: { code: "idempotency_conflict", status: 409 },
    insufficient_credits: { code: "insufficient_credits", status: 402 },
    job_already_terminal: { code: "job_already_terminal", status: 409 },
    job_not_found: { code: "job_not_found", status: 404 },
    unauthorized: { code: "unauthorized", status: 401 },
  };
  const classification = detail ? mapped[detail] : undefined;
  return new AppError({
    code: classification?.code ?? fallback,
    statusCode: classification?.status ?? 500,
    message: safeMessage(classification?.code ?? fallback),
    expose: classification !== undefined,
    cause: error,
  });
}

function invalidRpcResult(operation: string): AppError {
  return new AppError({
    code: "application_error",
    statusCode: 500,
    message: `Database returned an invalid ${operation} result.`,
  });
}

function safeMessage(code: AppErrorCode): string {
  switch (code) {
    case "idempotency_conflict":
      return "The idempotency key was already used for a different request.";
    case "insufficient_credits":
      return "Insufficient credits.";
    case "job_already_terminal":
      return "The job has already completed.";
    case "job_not_found":
      return "Job not found.";
    case "forbidden":
      return "Access denied.";
    case "unauthorized":
      return "Authentication is required.";
    default:
      return "Generation state update failed.";
  }
}
