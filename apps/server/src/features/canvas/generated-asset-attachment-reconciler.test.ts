import { describe, expect, it, vi } from "vitest";

import type { AdminSupabaseClient } from "../../supabase/admin.js";
import { createGeneratedAssetAttachmentTemplateAdapter } from "./generated-asset-application-adapter.js";
import { createGeneratedAssetAttachmentReconciler } from "./generated-asset-attachment-reconciler.js";

const intent = {
  id: "11111111-1111-4111-8111-111111111111",
  job_id: "22222222-2222-4222-8222-222222222222",
  effect_kind: "generated_asset_attached" as const,
  state: "running" as const,
  workspace_id: "33333333-3333-4333-8333-333333333333",
  project_id: "44444444-4444-4444-8444-444444444444",
  canvas_id: "55555555-5555-4555-8555-555555555555",
  session_id: "66666666-6666-4666-8666-666666666666",
  user_id: "77777777-7777-4777-8777-777777777777",
  media_type: "image" as const,
  placement_policy: { kind: "auto_right" as const },
  run_id: "88888888-8888-4888-8888-888888888888",
  attempt_id: "99999999-9999-4999-8999-999999999999",
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

function setup(
  overrides: {
    claim?: () => Promise<(typeof intent)[]>;
    prepare?: () => Promise<unknown>;
  } = {},
) {
  const repository = {
    claim: vi.fn(overrides.claim ?? (async () => [intent])),
    fulfill: vi.fn(async () => ({
      attachmentStatus: "attached" as const,
      jobId: intent.job_id,
      canvasId: intent.canvas_id,
      elementId: intent.job_id,
      canvasRevision: 2,
      replayed: false,
    })),
    settle: vi.fn(async (command) => ({
      ...intent,
      state: command.outcome,
    })),
  };
  const templates = {
    prepare: vi.fn(
      overrides.prepare ??
        (async () => ({
          kind: "ready",
          element: {
            id: intent.job_id,
            type: "image",
            fileId: `${intent.job_id}-file`,
          },
          file: {
            id: `${intent.job_id}-file`,
            assetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          },
        })),
    ),
  };
  const reconciler = createGeneratedAssetAttachmentReconciler({
    repository: repository as never,
    templates: templates as never,
    workerId: "worker-1",
    now: () => new Date("2026-08-20T01:00:00.000Z"),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  return { reconciler, repository, templates };
}

describe("generated asset attachment reconciler", () => {
  it("claims and fulfills a trusted generated asset", async () => {
    const { reconciler, repository } = setup();

    await expect(reconciler.reconcileOnce()).resolves.toEqual({
      claimed: 1,
      attached: 1,
      retried: 0,
      failed: 0,
    });
    expect(repository.claim).toHaveBeenCalledWith(
      expect.objectContaining({ leaseSeconds: 30 }),
    );
    expect(repository.fulfill).toHaveBeenCalledWith(
      expect.objectContaining({
        intentId: intent.id,
        claimFence: 3,
        agentAttemptId: intent.attempt_id,
        agentFencingToken: 7,
      }),
    );
  });

  it("maps canceled and dead-letter generation outcomes without fulfillment", async () => {
    const canceled = setup({
      prepare: async () => ({
        kind: "terminal_without_asset",
        outcome: "canceled",
        errorCode: "generation_canceled",
      }),
    });
    await canceled.reconciler.reconcileOnce();
    expect(canceled.repository.settle).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "canceled" }),
    );
    expect(canceled.repository.fulfill).not.toHaveBeenCalled();

    const failed = setup({
      prepare: async () => ({
        kind: "terminal_without_asset",
        outcome: "failed",
        errorCode: "generation_dead_lettered",
      }),
    });
    await failed.reconciler.reconcileOnce();
    expect(failed.repository.settle).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "failed" }),
    );
  });

  it("uses bounded exponential retry delays and exhausts the eighth attempt", async () => {
    for (const [attemptCount, delaySeconds] of [
      [1, 1],
      [2, 2],
      [3, 4],
      [4, 8],
      [5, 16],
      [6, 32],
      [7, 60],
    ] as const) {
      const current = { ...intent, attempt_count: attemptCount };
      const currentSetup = setup({
        claim: async () => [current],
        prepare: async () => {
          throw Object.assign(new Error("temporary"), {
            code: "attachment_infrastructure_error",
          });
        },
      });
      await currentSetup.reconciler.reconcileOnce();
      expect(currentSetup.repository.settle).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: "retry_wait",
          nextAttemptAt: new Date(
            new Date("2026-08-20T01:00:00.000Z").getTime() +
              delaySeconds * 1_000,
          ),
        }),
      );
    }

    const exhausted = setup({
      claim: async () => [{ ...intent, attempt_count: 8 }],
      prepare: async () => {
        throw new Error("temporary");
      },
    });
    await exhausted.reconciler.reconcileOnce();
    expect(exhausted.repository.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failed",
        errorCode: "attachment_attempts_exhausted",
      }),
    );
  });

  it("marks deterministic integrity failures without retrying", async () => {
    const current = setup({
      prepare: async () => {
        throw Object.assign(new Error("mismatch"), {
          code: "attachment_integrity_failure",
        });
      },
    });
    await current.reconciler.reconcileOnce();
    expect(current.repository.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failed",
        errorCode: "attachment_integrity_failure",
      }),
    );
  });

  it("scans immediately, every five seconds, wakes early, and waits on stop", async () => {
    vi.useFakeTimers();
    try {
      const current = setup({ claim: async () => [] });
      await current.reconciler.start();
      expect(current.repository.claim).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(current.repository.claim).toHaveBeenCalledTimes(2);

      current.reconciler.wake();
      await vi.advanceTimersByTimeAsync(0);
      expect(current.repository.claim).toHaveBeenCalledTimes(3);
      await current.reconciler.stop();

      await vi.advanceTimersByTimeAsync(10_000);
      expect(current.repository.claim).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("generated asset attachment templates", () => {
  it("derives an image element and bounded asset reference from trusted rows", async () => {
    const from = createSourceClient({
      job: {
        id: intent.job_id,
        status: "succeeded",
        job_type: "image_generation",
        workspace_id: intent.workspace_id,
        project_id: intent.project_id,
        canvas_id: intent.canvas_id,
        session_id: intent.session_id,
        created_by: intent.user_id,
        payload: { title: "Generated image", prompt: "secret prompt" },
        result: {
          asset_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          width: 1200,
          height: 800,
          object_path: "secret/path.png",
          signed_url: "https://signed.example/secret",
        },
      },
      asset: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        workspace_id: intent.workspace_id,
        project_id: intent.project_id,
        generation_job_id: intent.job_id,
        mime_type: "image/png",
      },
    });
    const adapter = createGeneratedAssetAttachmentTemplateAdapter({
      getAdminClient: () => ({ from }) as unknown as AdminSupabaseClient,
      now: () => new Date("2026-08-20T01:00:00.000Z"),
    });

    const prepared = await adapter.prepare(intent);
    expect(prepared).toMatchObject({
      kind: "ready",
      element: {
        id: intent.job_id,
        type: "image",
        fileId: `${intent.job_id}-file`,
        width: 600,
        height: 400,
      },
      file: {
        id: `${intent.job_id}-file`,
        assetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        mimeType: "image/png",
        created: expect.any(Number),
      },
    });
    expect(JSON.stringify(prepared)).not.toContain("secret/path");
    expect(JSON.stringify(prepared)).not.toContain("signed.example");
    expect(JSON.stringify(prepared)).not.toContain("secret prompt");
  });

  it("maps terminal jobs and creates same-origin video references", async () => {
    const canceled = createGeneratedAssetAttachmentTemplateAdapter({
      getAdminClient: () =>
        ({
          from: createSourceClient({
            job: { id: intent.job_id, status: "canceled" },
          }),
        }) as unknown as AdminSupabaseClient,
    });
    await expect(canceled.prepare(intent)).resolves.toEqual({
      kind: "terminal_without_asset",
      outcome: "canceled",
      errorCode: "generation_canceled",
    });

    const videoIntent = { ...intent, media_type: "video" as const };
    const assetId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const video = createGeneratedAssetAttachmentTemplateAdapter({
      getAdminClient: () =>
        ({
          from: createSourceClient({
            job: {
              id: intent.job_id,
              status: "succeeded",
              job_type: "video_generation",
              workspace_id: intent.workspace_id,
              project_id: intent.project_id,
              canvas_id: intent.canvas_id,
              session_id: intent.session_id,
              created_by: intent.user_id,
              payload: {},
              result: {
                asset_id: assetId,
                width: 1920,
                height: 1080,
                duration_seconds: 6,
                signed_url: "https://signed.example/secret",
              },
            },
            asset: {
              id: assetId,
              workspace_id: intent.workspace_id,
              project_id: intent.project_id,
              generation_job_id: intent.job_id,
              mime_type: "video/mp4",
            },
          }),
        }) as unknown as AdminSupabaseClient,
    });
    await expect(video.prepare(videoIntent)).resolves.toMatchObject({
      kind: "ready",
      element: {
        type: "embeddable",
        link: `/api/assets/${assetId}`,
        customData: { assetId, isVideo: true },
      },
      file: null,
    });
  });
});

function createSourceClient(options: {
  job: Record<string, unknown>;
  asset?: Record<string, unknown>;
}) {
  return vi.fn((table: string) => ({
    select: () => {
      const query = {
        eq: () => query,
        maybeSingle: async () => ({
          data: table === "background_jobs" ? options.job : options.asset,
          error: null,
        }),
      };
      return query;
    },
  }));
}
