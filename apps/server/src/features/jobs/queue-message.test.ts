import { describe, expect, it, vi } from "vitest";

import {
  createGenerationQueueMessage,
  resolveGenerationQueueMessage,
  settleNonReadyGenerationQueueMessage,
  settleRejectedGenerationQueueMessage,
} from "./queue-message.js";

const ids = {
  job: "550e8400-e29b-41d4-a716-446655440000",
  workspace: "550e8400-e29b-41d4-a716-446655440001",
  canvas: "550e8400-e29b-41d4-a716-446655440002",
  session: "550e8400-e29b-41d4-a716-446655440003",
};

const imageJob = {
  id: ids.job,
  job_type: "image_generation" as const,
  workspace_id: ids.workspace,
  project_id: null,
  canvas_id: ids.canvas,
  session_id: ids.session,
  thread_id: "thread-123",
  payload: { prompt: "A product photograph", aspect_ratio: "1:1" },
};

describe("generation queue boundary", () => {
  it("creates a hybrid v1 message readable by old workers", () => {
    const message = createGenerationQueueMessage({
      jobId: ids.job,
      workspaceId: ids.workspace,
      canvasId: ids.canvas,
      sessionId: ids.session,
      threadId: "thread-123",
      jobType: "image_generation",
      payload: imageJob.payload,
    });

    expect(message).toMatchObject({
      job_id: ids.job,
      job_type: "image_generation",
      workspace_id: ids.workspace,
      canvas_id: ids.canvas,
      session_id: ids.session,
      schemaVersion: 1,
      type: "image_generation",
      payload: { job_id: ids.job, workspace_id: ids.workspace },
    });
  });

  it("normalizes a trustworthy legacy message using the authoritative job", async () => {
    const lookupJob = vi.fn().mockResolvedValue(imageJob);
    const result = await resolveGenerationQueueMessage({
      queue: "image_generation_jobs",
      message: {
        job_id: ids.job,
        job_type: "image_generation",
        workspace_id: ids.workspace,
        canvas_id: ids.canvas,
        session_id: ids.session,
      },
      lookupJob,
    });

    expect(lookupJob).toHaveBeenCalledWith(ids.job);
    expect(result).toMatchObject({
      status: "ready",
      dispatch: {
        jobId: ids.job,
        jobType: "image_generation",
        payload: {
          job_id: ids.job,
          workspace_id: ids.workspace,
          prompt: "A product photograph",
        },
      },
    });
  });

  it("rejects a message whose type does not match the physical queue", async () => {
    const result = await resolveGenerationQueueMessage({
      queue: "video_generation_jobs",
      message: {
        job_id: ids.job,
        job_type: "image_generation",
        workspace_id: ids.workspace,
      },
      lookupJob: vi.fn().mockResolvedValue(imageJob),
    });

    expect(result).toMatchObject({
      status: "rejected",
      jobId: ids.job,
      code: "queue_type_mismatch",
    });
  });

  it("leaves message and job state untouched when authoritative lookup is unavailable", async () => {
    const actions = {
      markDeadLetter: vi.fn().mockResolvedValue(undefined),
      archive: vi.fn().mockResolvedValue(undefined),
      refund: vi.fn().mockResolvedValue(undefined),
    };
    const resolution = await resolveGenerationQueueMessage({
      queue: "image_generation_jobs",
      message: {
        job_id: ids.job,
        job_type: "image_generation",
        workspace_id: ids.workspace,
      },
      lookupJob: vi.fn().mockRejectedValue(
        Object.assign(new Error("database unavailable"), {
          code: "job_query_failed",
        }),
      ),
    });

    expect(resolution).toMatchObject({
      status: "retryable",
      jobId: ids.job,
      code: "job_lookup_unavailable",
    });
    if (resolution.status === "ready") {
      throw new Error("Expected non-ready queue resolution.");
    }

    expect(
      await settleNonReadyGenerationQueueMessage(resolution, actions),
    ).toBe("retry");
    expect(actions.markDeadLetter).not.toHaveBeenCalled();
    expect(actions.archive).not.toHaveBeenCalled();
    expect(actions.refund).not.toHaveBeenCalled();
  });

  it("archives a permanently orphaned message without dead-letter or refund", async () => {
    const actions = {
      markDeadLetter: vi.fn().mockResolvedValue(undefined),
      archive: vi.fn().mockResolvedValue(undefined),
      refund: vi.fn().mockResolvedValue(undefined),
    };
    const resolution = await resolveGenerationQueueMessage({
      queue: "image_generation_jobs",
      message: {
        job_id: ids.job,
        job_type: "image_generation",
        workspace_id: ids.workspace,
      },
      lookupJob: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("not found"), { code: "job_not_found" }),
        ),
    });

    expect(resolution).toMatchObject({
      status: "poison",
      jobId: ids.job,
      code: "orphaned_queue_job",
    });
    if (resolution.status === "ready") {
      throw new Error("Expected non-ready queue resolution.");
    }

    expect(
      await settleNonReadyGenerationQueueMessage(resolution, actions),
    ).toBe("archived");
    expect(actions.archive).toHaveBeenCalledOnce();
    expect(actions.markDeadLetter).not.toHaveBeenCalled();
    expect(actions.refund).not.toHaveBeenCalled();
  });

  it.each([
    ["job_type", { ...imageJob, job_type: "video_generation" }],
    ["workspace_id", { ...imageJob, workspace_id: ids.canvas }],
    ["canvas_id", { ...imageJob, canvas_id: ids.workspace }],
  ])("rejects %s mismatch with the authoritative job", async (_, job) => {
    const result = await resolveGenerationQueueMessage({
      queue: "image_generation_jobs",
      message: {
        job_id: ids.job,
        job_type: "image_generation",
        workspace_id: ids.workspace,
        canvas_id: ids.canvas,
        session_id: ids.session,
        thread_id: "thread-123",
      },
      lookupJob: vi.fn().mockResolvedValue(job),
    });

    expect(result).toMatchObject({
      status: "rejected",
      jobId: ids.job,
      code: "queue_integrity_mismatch",
    });
  });

  it("dead-letters, archives, and refunds a recoverable rejection", async () => {
    const actions = {
      markDeadLetter: vi.fn().mockResolvedValue(undefined),
      archive: vi.fn().mockResolvedValue(undefined),
      refund: vi.fn().mockResolvedValue(undefined),
    };

    const resolution = await resolveGenerationQueueMessage({
      queue: "image_generation_jobs",
      message: {
        job_id: ids.job,
        job_type: "image_generation",
        workspace_id: ids.workspace,
        schemaVersion: 1,
        type: "image_generation",
        payload: {
          job_id: ids.job,
          workspace_id: ids.workspace,
          prompt: "Wrong media fields",
          duration: 5,
        },
      },
      lookupJob: vi.fn().mockResolvedValue(imageJob),
    });

    expect(resolution).toMatchObject({
      status: "rejected",
      jobId: ids.job,
      code: "invalid_queue_message",
    });
    if (resolution.status !== "rejected") {
      throw new Error("Expected recoverable queue rejection.");
    }

    await settleRejectedGenerationQueueMessage(resolution, actions);

    expect(actions.markDeadLetter).toHaveBeenCalledWith(
      ids.job,
      "invalid_queue_message",
      expect.any(String),
    );
    expect(actions.archive).toHaveBeenCalledOnce();
    expect(actions.refund).toHaveBeenCalledWith(ids.job);
    expect(
      actions.markDeadLetter.mock.invocationCallOrder[0] ?? 0,
    ).toBeLessThan(
      actions.archive.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });
});
