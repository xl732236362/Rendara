import { type BackgroundJob, backgroundJobSchema } from "@loomic/shared";
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

const claimSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("missing") }),
  z.object({ kind: z.literal("busy"), job: backgroundJobSchema }),
  z.object({ kind: z.literal("terminal"), job: backgroundJobSchema }),
  z.object({
    kind: z.literal("claimed"),
    job: backgroundJobSchema,
    lease_token: z.string().uuid(),
  }),
]);

const settlementSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("failed"), job: backgroundJobSchema }),
  z.object({ kind: z.literal("terminal"), job: backgroundJobSchema }),
]);

const effectAttemptSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("started"), replayed: z.boolean() }),
  z.object({
    kind: z.literal("completed"),
    result: z.record(z.string(), z.unknown()),
  }),
  z.object({ kind: z.literal("ambiguous") }),
]);

export type JobClaim = z.infer<typeof claimSchema>;
export type JobSettlement = z.infer<typeof settlementSchema>;

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
  claim(
    jobId: string,
    workerId: string,
    leaseSeconds: number,
  ): Promise<JobClaim>;
  beginEffect(
    jobId: string,
    leaseToken: string,
  ): Promise<z.infer<typeof effectAttemptSchema>>;
  renew(
    jobId: string,
    leaseToken: string,
    leaseSeconds: number,
  ): Promise<BackgroundJob>;
  settle(command: {
    jobId: string;
    leaseToken: string;
    outcome: "succeeded" | "failed" | "dead_letter" | "canceled";
    result?: Record<string, unknown>;
    errorCode?: string;
    errorMessage?: string;
  }): Promise<JobSettlement>;
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

    async claim(jobId, workerId, leaseSeconds) {
      const { data, error } = await callRpc(
        options.getAdminClient(),
        "claim_generation_job",
        {
          p_job_id: jobId,
          p_lease_owner: workerId,
          p_lease_seconds: leaseSeconds,
        },
      );
      if (error) throw mapRpcError(error, "job_query_failed");
      const parsed = claimSchema.safeParse(data);
      if (!parsed.success) throw invalidRpcResult("generation job claim");
      return parsed.data;
    },

    async renew(jobId, leaseToken, leaseSeconds) {
      const { data, error } = await callRpc(
        options.getAdminClient(),
        "renew_generation_job_lease",
        {
          p_job_id: jobId,
          p_lease_token: leaseToken,
          p_lease_seconds: leaseSeconds,
        },
      );
      if (error) throw mapRpcError(error, "job_query_failed");
      const parsed = backgroundJobSchema.safeParse(data);
      if (!parsed.success) throw invalidRpcResult("generation lease renewal");
      return parsed.data;
    },

    async beginEffect(jobId, leaseToken) {
      const { data, error } = await callRpc(
        options.getAdminClient(),
        "begin_generation_effect",
        { p_job_id: jobId, p_lease_token: leaseToken },
      );
      if (error) throw mapRpcError(error, "job_query_failed");
      const parsed = effectAttemptSchema.safeParse(data);
      if (!parsed.success) throw invalidRpcResult("generation effect attempt");
      return parsed.data;
    },

    async settle(command) {
      const { data, error } = await callRpc(
        options.getAdminClient(),
        "settle_generation_job",
        {
          p_job_id: command.jobId,
          p_lease_token: command.leaseToken,
          p_outcome: command.outcome,
          p_result: command.result ?? null,
          p_error_code: command.errorCode ?? null,
          p_error_message: command.errorMessage ?? null,
        },
      );
      if (error) throw mapRpcError(error, "job_query_failed");
      const parsed = settlementSchema.safeParse(data);
      if (!parsed.success) throw invalidRpcResult("generation settlement");
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
    stale_job_lease: { code: "stale_job_lease", status: 409 },
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
    case "stale_job_lease":
      return "The job lease is no longer valid.";
    case "forbidden":
      return "Access denied.";
    case "unauthorized":
      return "Authentication is required.";
    default:
      return "Generation state update failed.";
  }
}
