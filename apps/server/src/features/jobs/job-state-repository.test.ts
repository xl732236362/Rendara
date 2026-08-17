import type { BackgroundJob } from "@loomic/shared";
import { describe, expect, it, vi } from "vitest";

import type { AdminSupabaseClient } from "../../supabase/admin.js";
import type {
  AuthenticatedUser,
  UserSupabaseClient,
} from "../../supabase/user.js";
import { createJobStateRepository } from "./job-state-repository.js";

const user: AuthenticatedUser = {
  id: "11111111-1111-4111-8111-111111111111",
  accessToken: "access-token",
  email: "",
  userMetadata: {},
};

const job: BackgroundJob = {
  id: "44444444-4444-4444-8444-444444444444",
  workspace_id: "55555555-5555-4555-8555-555555555555",
  project_id: null,
  canvas_id: null,
  session_id: null,
  thread_id: null,
  queue_name: "generation_jobs",
  job_type: "image_generation",
  status: "queued",
  payload: { prompt: "draw" },
  result: null,
  error_code: null,
  error_message: null,
  attempt_count: 0,
  max_attempts: 3,
  transition_version: 0,
  lease_token: null,
  lease_owner: null,
  lease_expires_at: null,
  pgmq_message_id: null,
  credits_transaction_id: "77777777-7777-4777-8777-777777777777",
  credits_cost: 7,
  created_by: user.id,
  created_at: "2026-08-18T00:00:00.000Z",
  updated_at: "2026-08-18T00:00:00.000Z",
  started_at: null,
  completed_at: null,
  failed_at: null,
  canceled_at: null,
};

const command = {
  workspaceId: job.workspace_id,
  jobType: "image_generation" as const,
  idempotencyKey: "request-1",
  requestFingerprint:
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  creditsCost: 7,
  description: "Image generation: image/default",
  payload: job.payload,
};

function setup(adminResult: unknown, userResult: unknown = null) {
  const adminRpc = vi.fn(async () => adminResult);
  const userRpc = vi.fn(async () => userResult);
  return {
    adminRpc,
    userRpc,
    repository: createJobStateRepository({
      getAdminClient: () =>
        ({ rpc: adminRpc }) as unknown as AdminSupabaseClient,
      createUserClient: () =>
        ({ rpc: userRpc }) as unknown as UserSupabaseClient,
    }),
  };
}

describe("job state repository", () => {
  it("submits the charge and job in one service-role RPC", async () => {
    const { repository, adminRpc } = setup({
      data: {
        job,
        debit_transaction_id: job.credits_transaction_id,
        replayed: false,
      },
      error: null,
    });

    await expect(repository.submit(user, command)).resolves.toEqual({
      job,
      debitTransactionId: job.credits_transaction_id,
      replayed: false,
    });
    expect(adminRpc).toHaveBeenCalledWith("submit_generation_job", {
      p_workspace_id: job.workspace_id,
      p_user_id: user.id,
      p_idempotency_key: "request-1",
      p_request_fingerprint: command.requestFingerprint,
      p_job_type: "image_generation",
      p_payload: job.payload,
      p_credits_cost: 7,
      p_description: command.description,
      p_project_id: null,
      p_canvas_id: null,
      p_session_id: null,
      p_thread_id: null,
    });
  });

  it.each([
    ["idempotency_conflict", "idempotency_conflict", 409],
    ["insufficient_credits", "insufficient_credits", 402],
  ] as const)(
    "maps %s without exposing database details",
    async (details, code, statusCode) => {
      const secret = "internal SQL message containing request-1";
      const { repository } = setup({
        data: null,
        error: { details, message: secret },
      });

      const error = await repository
        .submit(user, command)
        .catch((value) => value);
      expect(error).toMatchObject({ code, statusCode, expose: true });
      expect(error.message).not.toContain(secret);
      expect(error.message).not.toContain(command.idempotencyKey);
    },
  );

  it("rejects an invalid submission result", async () => {
    const { repository } = setup({ data: { replayed: false }, error: null });
    await expect(repository.submit(user, command)).rejects.toMatchObject({
      code: "application_error",
      statusCode: 500,
      expose: false,
    });
  });

  it("requests cancellation with the authenticated client", async () => {
    const canceledJob = { ...job, status: "canceled" as const };
    const { repository, userRpc } = setup(null, {
      data: { job: canceledJob, replayed: false },
      error: null,
    });

    await expect(repository.requestCancellation(user, job.id)).resolves.toEqual(
      {
        job: canceledJob,
        replayed: false,
      },
    );
    expect(userRpc).toHaveBeenCalledWith("request_generation_cancellation", {
      p_job_id: job.id,
    });
  });

  it("claims and settles a job with the same lease token", async () => {
    const leaseToken = "88888888-8888-4888-8888-888888888888";
    const runningJob = {
      ...job,
      status: "running" as const,
      attempt_count: 1,
      lease_token: leaseToken,
      lease_owner: "worker-1",
      lease_expires_at: "2026-08-18T00:01:00.000Z",
    };
    const adminRpc = vi
      .fn()
      .mockResolvedValueOnce({
        data: { kind: "claimed", job: runningJob, lease_token: leaseToken },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { kind: "terminal", job: { ...runningJob, status: "succeeded" } },
        error: null,
      });
    const repository = createJobStateRepository({
      getAdminClient: () =>
        ({ rpc: adminRpc }) as unknown as AdminSupabaseClient,
      createUserClient: () => ({}) as UserSupabaseClient,
    });

    await expect(
      repository.claim(job.id, "worker-1", 30),
    ).resolves.toMatchObject({
      kind: "claimed",
      lease_token: leaseToken,
    });
    await repository.settle({
      jobId: job.id,
      leaseToken,
      outcome: "succeeded",
      result: { url: "stored" },
    });
    expect(adminRpc).toHaveBeenNthCalledWith(2, "settle_generation_job", {
      p_job_id: job.id,
      p_lease_token: leaseToken,
      p_outcome: "succeeded",
      p_result: { url: "stored" },
      p_error_code: null,
      p_error_message: null,
    });
  });

  it("maps stale lease renewal to a safe conflict", async () => {
    const secret = "raw lease token must stay private";
    const { repository } = setup({
      data: null,
      error: { details: "stale_job_lease", message: secret },
    });
    const error = await repository
      .renew(job.id, "88888888-8888-4888-8888-888888888888", 30)
      .catch((value) => value);
    expect(error).toMatchObject({
      code: "stale_job_lease",
      statusCode: 409,
      expose: true,
    });
    expect(error.message).not.toContain(secret);
  });
});
