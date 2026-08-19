import { describe, expect, it, vi } from "vitest";

import type { AdminSupabaseClient } from "../../supabase/admin.js";
import { createGeneratedAssetAttachmentRepository } from "./generated-asset-attachment-repository.js";

const ids = {
  intent: "11111111-1111-4111-8111-111111111111",
  job: "22222222-2222-4222-8222-222222222222",
  workspace: "33333333-3333-4333-8333-333333333333",
  project: "44444444-4444-4444-8444-444444444444",
  canvas: "55555555-5555-4555-8555-555555555555",
  session: "66666666-6666-4666-8666-666666666666",
  user: "77777777-7777-4777-8777-777777777777",
  run: "88888888-8888-4888-8888-888888888888",
  attempt: "99999999-9999-4999-8999-999999999999",
};

const claimedIntent = {
  id: ids.intent,
  job_id: ids.job,
  effect_kind: "generated_asset_attached",
  state: "running",
  workspace_id: ids.workspace,
  project_id: ids.project,
  canvas_id: ids.canvas,
  session_id: ids.session,
  user_id: ids.user,
  media_type: "image",
  placement_policy: { kind: "auto_right" },
  run_id: ids.run,
  attempt_id: ids.attempt,
  fencing_token: 7,
  logical_tool_call_id: "tool-1",
  input_digest:
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  claim_owner: "worker-1",
  claim_expires_at: "2026-08-20T01:00:30.000Z",
  claim_fencing_token: 3,
  attempt_count: 1,
  next_attempt_at: "2026-08-20T01:00:00.000Z",
  result: null,
  error_code: null,
  created_at: "2026-08-20T00:00:00.000Z",
  updated_at: "2026-08-20T01:00:00.000Z",
  attached_at: null,
};

function setup(results: Array<{ data: unknown; error: unknown }>) {
  const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>) =>
    results.shift(),
  );
  return {
    rpc,
    repository: createGeneratedAssetAttachmentRepository({
      getAdminClient: () => ({ rpc }) as unknown as AdminSupabaseClient,
    }),
  };
}

describe("generated asset attachment repository", () => {
  it("claims due terminal intents with a bounded lease", async () => {
    const { repository, rpc } = setup([{ data: [claimedIntent], error: null }]);

    await expect(
      repository.claim({
        workerId: "worker-1",
        limit: 20,
        leaseSeconds: 30,
        now: new Date("2026-08-20T01:00:00.000Z"),
      }),
    ).resolves.toEqual([claimedIntent]);
    expect(rpc).toHaveBeenCalledWith(
      "claim_generated_asset_attachment_intents",
      {
        p_worker_id: "worker-1",
        p_limit: 20,
        p_lease_seconds: 30,
        p_now: "2026-08-20T01:00:00.000Z",
      },
    );
  });

  it("settles retries with the current claim fence and next attempt", async () => {
    const retried = {
      ...claimedIntent,
      state: "retry_wait",
      claim_owner: null,
      claim_expires_at: null,
      error_code: "attachment_infrastructure_error",
      next_attempt_at: "2026-08-20T01:00:02.000Z",
    };
    const { repository, rpc } = setup([{ data: retried, error: null }]);

    await expect(
      repository.settle({
        intentId: ids.intent,
        claimFence: 3,
        outcome: "retry_wait",
        errorCode: "attachment_infrastructure_error",
        nextAttemptAt: new Date("2026-08-20T01:00:02.000Z"),
      }),
    ).resolves.toEqual(retried);
    expect(rpc).toHaveBeenCalledWith(
      "settle_generated_asset_attachment_intent",
      expect.objectContaining({
        p_intent_id: ids.intent,
        p_claim_fence: 3,
        p_outcome: "retry_wait",
        p_next_attempt_at: "2026-08-20T01:00:02.000Z",
      }),
    );
  });

  it("fulfills with trusted templates and parses the attachment receipt", async () => {
    const receipt = {
      attachmentStatus: "attached",
      jobId: ids.job,
      canvasId: ids.canvas,
      elementId: ids.job,
      canvasRevision: 9,
      replayed: false,
    };
    const { repository, rpc } = setup([{ data: receipt, error: null }]);
    const element = { id: ids.job, type: "image", fileId: `${ids.job}-file` };
    const file = {
      id: `${ids.job}-file`,
      assetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    };

    await expect(
      repository.fulfill({
        intentId: ids.intent,
        claimFence: 3,
        element,
        file,
        agentAttemptId: ids.attempt,
        agentFencingToken: 7,
      }),
    ).resolves.toEqual(receipt);
    expect(rpc).toHaveBeenCalledWith("fulfill_generated_asset_attachment", {
      p_intent_id: ids.intent,
      p_claim_fence: 3,
      p_element_template: element,
      p_file_template: file,
      p_agent_attempt_id: ids.attempt,
      p_agent_fencing_token: 7,
    });
  });

  it("rejects malformed service-role RPC results", async () => {
    const { repository } = setup([{ data: [{ id: "bad" }], error: null }]);
    await expect(
      repository.claim({
        workerId: "worker-1",
        limit: 20,
        leaseSeconds: 30,
        now: new Date(),
      }),
    ).rejects.toMatchObject({ code: "application_error", expose: false });
  });

  it("reads status through a fully scoped authorization RPC", async () => {
    const pending = pendingStatus();
    const { repository, rpc } = setup([{ data: pending, error: null }]);

    await expect(repository.getStatus(scope())).resolves.toEqual(pending);
    expect(rpc).toHaveBeenCalledWith("get_generated_asset_attachment_status", {
      p_user_id: ids.user,
      p_workspace_id: ids.workspace,
      p_canvas_id: ids.canvas,
      p_job_id: ids.job,
    });
  });

  it("lists bounded outstanding statuses for one authorized session", async () => {
    const pending = pendingStatus();
    const { repository, rpc } = setup([{ data: [pending], error: null }]);

    await expect(
      repository.listOutstanding({
        userId: ids.user,
        workspaceId: ids.workspace,
        canvasId: ids.canvas,
        sessionId: ids.session,
        limit: 100,
      }),
    ).resolves.toEqual([pending]);
    expect(rpc).toHaveBeenCalledWith(
      "list_generated_asset_attachment_statuses",
      {
        p_user_id: ids.user,
        p_workspace_id: ids.workspace,
        p_canvas_id: ids.canvas,
        p_session_id: ids.session,
        p_limit: 100,
      },
    );
  });

  it("retries a failed intent after scope authorization and re-reads status", async () => {
    const failed = {
      attachmentStatus: "not_attached",
      jobId: ids.job,
      recovery: {
        kind: "attach_generated_asset",
        jobId: ids.job,
        canvasId: ids.canvas,
      },
      error: {
        code: "attachment_failed",
        message: "Generated media was not attached.",
        retryable: true,
      },
    };
    const pending = pendingStatus();
    const { repository, rpc } = setup([
      { data: failed, error: null },
      { data: { state: "pending" }, error: null },
      { data: pending, error: null },
    ]);

    await expect(repository.retry(scope())).resolves.toEqual(pending);
    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      "get_generated_asset_attachment_status",
      "retry_generated_asset_attachment",
      "get_generated_asset_attachment_status",
    ]);
  });

  it("replays an attached result without scheduling another retry", async () => {
    const attached = {
      attachmentStatus: "attached",
      jobId: ids.job,
      elementId: ids.job,
      canvasRevision: 9,
    };
    const { repository, rpc } = setup([{ data: attached, error: null }]);

    await expect(repository.retry(scope())).resolves.toEqual(attached);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("registers worker heartbeats and probes infrastructure readiness", async () => {
    const { repository, rpc } = setup([
      { data: true, error: null },
      { data: true, error: null },
    ]);

    await expect(
      repository.heartbeat({
        workerId: "worker-1",
        now: new Date("2026-08-20T01:00:00.000Z"),
      }),
    ).resolves.toBeUndefined();
    await expect(
      repository.isInfrastructureReady({
        now: new Date("2026-08-20T01:00:00.000Z"),
        maxHeartbeatAgeSeconds: 30,
      }),
    ).resolves.toBe(true);
    expect(rpc.mock.calls).toEqual([
      [
        "heartbeat_generated_asset_attachment_worker",
        {
          p_worker_id: "worker-1",
          p_now: "2026-08-20T01:00:00.000Z",
        },
      ],
      [
        "generated_asset_attachment_infrastructure_ready",
        {
          p_now: "2026-08-20T01:00:00.000Z",
          p_max_heartbeat_age_seconds: 30,
        },
      ],
    ]);
  });
});

function scope() {
  return {
    userId: ids.user,
    workspaceId: ids.workspace,
    canvasId: ids.canvas,
    jobId: ids.job,
  };
}

function pendingStatus() {
  return {
    attachmentStatus: "pending" as const,
    jobId: ids.job,
    recovery: {
      kind: "watch_generated_asset" as const,
      jobId: ids.job,
      canvasId: ids.canvas,
    },
    error: {
      code: "generated_asset_pending",
      message: "Generated media is still being attached.",
      retryable: true,
    },
  };
}
