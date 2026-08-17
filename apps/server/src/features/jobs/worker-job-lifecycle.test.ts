import { describe, expect, it, vi } from "vitest";

import { createWorkerJobLifecycle } from "./worker-job-lifecycle.js";

const message = {
  jobId: "550e8400-e29b-41d4-a716-446655440000",
  jobType: "image_generation" as const,
  payload: { prompt: "draw" },
  queue: "image_generation_jobs",
  messageId: 17,
};

function setup(
  claim: unknown,
  executor = vi.fn(async () => ({ url: "result" })),
) {
  const jobs = {
    claim: vi.fn(async () => claim),
    renew: vi.fn(async () => ({})),
    settle: vi.fn(async (command) => ({
      kind: command.outcome === "failed" ? "failed" : "terminal",
      job: { status: command.outcome },
    })),
  };
  const queue = {
    deleteMessage: vi.fn(async () => undefined),
    archiveMessage: vi.fn(async () => undefined),
    renewMessage: vi.fn(async () => undefined),
  };
  const lifecycle = createWorkerJobLifecycle({
    jobs: jobs as never,
    executor,
    queue,
    workerId: "worker-1",
    leaseSeconds: 30,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  return { lifecycle, jobs, queue, executor };
}

describe("worker job lifecycle", () => {
  it("deletes a duplicate delivery for an already terminal job", async () => {
    const { lifecycle, executor, jobs, queue } = setup({
      kind: "terminal",
      job: { status: "succeeded" },
    });
    await expect(lifecycle.process(message)).resolves.toEqual({
      disposition: "duplicate_terminal",
    });
    expect(executor).not.toHaveBeenCalled();
    expect(jobs.settle).not.toHaveBeenCalled();
    expect(queue.deleteMessage).toHaveBeenCalledOnce();
  });

  it("leaves a busy delivery for retry", async () => {
    const { lifecycle, executor, queue } = setup({ kind: "busy", job: {} });
    await expect(lifecycle.process(message)).resolves.toEqual({
      disposition: "busy",
    });
    expect(executor).not.toHaveBeenCalled();
    expect(queue.deleteMessage).not.toHaveBeenCalled();
  });

  it("settles success before deleting the queue message", async () => {
    const { lifecycle, jobs, queue } = setup({
      kind: "claimed",
      lease_token: "77777777-7777-4777-8777-777777777777",
      job: { attempt_count: 1, max_attempts: 3 },
    });
    await expect(lifecycle.process(message)).resolves.toEqual({
      disposition: "succeeded",
    });
    expect(jobs.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "succeeded",
        leaseToken: "77777777-7777-4777-8777-777777777777",
      }),
    );
    expect(jobs.settle.mock.invocationCallOrder[0]).toBeLessThan(
      queue.deleteMessage.mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY,
    );
  });

  it("does not delete a stale worker result", async () => {
    const { lifecycle, jobs, queue } = setup({
      kind: "claimed",
      lease_token: "77777777-7777-4777-8777-777777777777",
      job: { attempt_count: 1, max_attempts: 3 },
    });
    jobs.settle.mockRejectedValueOnce(
      Object.assign(new Error("stale"), {
        code: "stale_job_lease",
      }),
    );
    await expect(lifecycle.process(message)).resolves.toEqual({
      disposition: "stale",
    });
    expect(queue.deleteMessage).not.toHaveBeenCalled();
    expect(queue.archiveMessage).not.toHaveBeenCalled();
  });

  it("settles retryable failure without refunding or removing the message", async () => {
    const executor = vi.fn(async () => {
      throw Object.assign(new Error("temporary"), { code: "provider_busy" });
    });
    const { lifecycle, jobs, queue } = setup(
      {
        kind: "claimed",
        lease_token: "77777777-7777-4777-8777-777777777777",
        job: { attempt_count: 1, max_attempts: 3 },
      },
      executor,
    );
    await expect(lifecycle.process(message)).resolves.toEqual({
      disposition: "retry",
    });
    expect(jobs.settle).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "failed" }),
    );
    expect(queue.deleteMessage).not.toHaveBeenCalled();
    expect(queue.archiveMessage).not.toHaveBeenCalled();
  });

  it("dead-letters a permanent failure and archives only after settlement", async () => {
    const executor = vi.fn(async () => {
      throw Object.assign(new Error("bad input"), { code: "invalid_input" });
    });
    const { lifecycle, jobs, queue } = setup(
      {
        kind: "claimed",
        lease_token: "77777777-7777-4777-8777-777777777777",
        job: { attempt_count: 1, max_attempts: 3 },
      },
      executor,
    );
    await expect(lifecycle.process(message)).resolves.toEqual({
      disposition: "dead_lettered",
    });
    expect(jobs.settle).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "dead_letter" }),
    );
    expect(queue.archiveMessage).toHaveBeenCalledOnce();
  });

  it("deletes a cancellation confirmed by settlement", async () => {
    const { lifecycle, jobs, queue } = setup({
      kind: "claimed",
      lease_token: "77777777-7777-4777-8777-777777777777",
      job: { attempt_count: 1, max_attempts: 3 },
    });
    jobs.settle.mockResolvedValueOnce({
      kind: "terminal",
      job: { status: "canceled" },
    });
    await expect(lifecycle.process(message)).resolves.toEqual({
      disposition: "canceled",
    });
    expect(queue.deleteMessage).toHaveBeenCalledOnce();
  });

  it("does not rewrite a succeeded job when queue deletion fails", async () => {
    const { lifecycle, jobs, queue } = setup({
      kind: "claimed",
      lease_token: "77777777-7777-4777-8777-777777777777",
      job: { attempt_count: 1, max_attempts: 3 },
    });
    queue.deleteMessage.mockRejectedValueOnce(new Error("queue unavailable"));

    await expect(lifecycle.process(message)).rejects.toThrow(
      "queue unavailable",
    );
    expect(jobs.settle).toHaveBeenCalledTimes(1);
    expect(jobs.settle).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "succeeded" }),
    );
  });
});
