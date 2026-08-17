import type {
  BackgroundJob,
  BackgroundJobStatus,
  BackgroundJobType,
} from "@loomic/shared";

import type { AtomicJobSubmissionCommand } from "../../application/generation/ports.js";
import type { AdminSupabaseClient } from "../../supabase/admin.js";
import type {
  AuthenticatedUser,
  UserSupabaseClient,
} from "../../supabase/user.js";
import { createJobStateRepository } from "./job-state-repository.js";

export class JobServiceError extends Error {
  readonly statusCode: number;
  readonly code:
    | "job_not_found"
    | "job_create_failed"
    | "job_query_failed"
    | "job_cancel_failed";

  constructor(
    code: JobServiceError["code"],
    message: string,
    statusCode: number,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "JobServiceError";
    this.code = code;
    this.statusCode = statusCode;
    this.cause = cause;
  }
}

export type SubmitJobInput = Omit<AtomicJobSubmissionCommand, "principal">;

export type JobService = {
  submitJob(
    user: AuthenticatedUser,
    input: SubmitJobInput,
  ): Promise<{
    job: BackgroundJob;
    debitTransactionId: string | null;
    replayed: boolean;
  }>;
  getJob(user: AuthenticatedUser, jobId: string): Promise<BackgroundJob>;
  listJobs(
    user: AuthenticatedUser,
    filters?: { status?: BackgroundJobStatus; jobType?: BackgroundJobType },
  ): Promise<BackgroundJob[]>;
  cancelJob(user: AuthenticatedUser, jobId: string): Promise<BackgroundJob>;
  getJobAdmin(jobId: string): Promise<BackgroundJob>;
};

export function createJobService(options: {
  createUserClient: (accessToken: string) => UserSupabaseClient;
  getAdminClient: () => AdminSupabaseClient;
}): JobService {
  const stateRepository = createJobStateRepository(options);
  function mapJobRow(row: Record<string, unknown>): BackgroundJob {
    return {
      id: row.id as string,
      workspace_id: row.workspace_id as string,
      project_id: (row.project_id as string) ?? null,
      canvas_id: (row.canvas_id as string) ?? null,
      session_id: (row.session_id as string) ?? null,
      thread_id: (row.thread_id as string) ?? null,
      queue_name: row.queue_name as string,
      job_type: row.job_type as BackgroundJob["job_type"],
      status: row.status as BackgroundJob["status"],
      payload: (row.payload as Record<string, unknown>) ?? {},
      result: (row.result as Record<string, unknown>) ?? null,
      error_code: (row.error_code as string) ?? null,
      error_message: (row.error_message as string) ?? null,
      attempt_count: row.attempt_count as number,
      max_attempts: row.max_attempts as number,
      transition_version: row.transition_version as number,
      lease_token: (row.lease_token as string) ?? null,
      lease_owner: (row.lease_owner as string) ?? null,
      lease_expires_at: (row.lease_expires_at as string) ?? null,
      pgmq_message_id: (row.pgmq_message_id as number) ?? null,
      credits_transaction_id: (row.credits_transaction_id as string) ?? null,
      credits_cost: (row.credits_cost as number) ?? null,
      created_by: row.created_by as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
      started_at: (row.started_at as string) ?? null,
      completed_at: (row.completed_at as string) ?? null,
      failed_at: (row.failed_at as string) ?? null,
      canceled_at: (row.canceled_at as string) ?? null,
    };
  }

  const SELECT_COLS =
    "id, workspace_id, project_id, canvas_id, session_id, thread_id, queue_name, job_type, status, payload, result, error_code, error_message, attempt_count, max_attempts, transition_version, lease_token, lease_owner, lease_expires_at, pgmq_message_id, credits_transaction_id, credits_cost, created_by, created_at, updated_at, started_at, completed_at, failed_at, canceled_at";

  return {
    submitJob(user, input) {
      return stateRepository.submit(user, input);
    },

    async getJob(user, jobId) {
      const client = options.createUserClient(user.accessToken);
      const { data: job, error } = await client
        .from("background_jobs")
        .select(SELECT_COLS)
        .eq("id", jobId)
        .maybeSingle();

      if (error) {
        throw new JobServiceError(
          "job_query_failed",
          "Failed to query job.",
          500,
        );
      }
      if (!job) {
        throw new JobServiceError("job_not_found", "Job not found.", 404);
      }
      return mapJobRow(job as unknown as Record<string, unknown>);
    },

    async listJobs(user, filters) {
      const client = options.createUserClient(user.accessToken);
      let query = client
        .from("background_jobs")
        .select(SELECT_COLS)
        .eq("created_by", user.id)
        .order("created_at", { ascending: false })
        .limit(50);

      if (filters?.status) query = query.eq("status", filters.status);
      if (filters?.jobType) query = query.eq("job_type", filters.jobType);

      const { data: jobs, error } = await query;
      if (error) {
        throw new JobServiceError(
          "job_query_failed",
          "Failed to list jobs.",
          500,
        );
      }
      return (jobs ?? []).map((row) =>
        mapJobRow(row as unknown as Record<string, unknown>),
      );
    },

    async cancelJob(user, jobId) {
      return (await stateRepository.requestCancellation(user, jobId)).job;
    },

    async getJobAdmin(jobId) {
      const admin = options.getAdminClient();
      const { data: job, error } = await admin
        .from("background_jobs")
        .select(SELECT_COLS)
        .eq("id", jobId)
        .maybeSingle();

      if (error) {
        throw new JobServiceError(
          "job_query_failed",
          "Failed to query job.",
          500,
        );
      }
      if (!job) {
        throw new JobServiceError("job_not_found", "Job not found.", 404);
      }
      return mapJobRow(job as unknown as Record<string, unknown>);
    },
  };
}
