import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { registerErrorHandler } from "./error-handler.js";
import { registerJobRoutes } from "./jobs.js";

const user = {
  accessToken: "token",
  email: "user@example.com",
  id: "11111111-1111-4111-8111-111111111111",
  userMetadata: {},
};
const workspaceId = "22222222-2222-4222-8222-222222222222";
const jobId = "33333333-3333-4333-8333-333333333333";

describe("HTTP job application wiring", () => {
  it.each([
    [
      "image-generation",
      { prompt: "image", aspect_ratio: "1:1" },
      { type: "image_generation", prompt: "image", aspect_ratio: "1:1" },
    ],
    [
      "video-generation",
      { prompt: "video", duration: 6, enable_audio: true },
      {
        type: "video_generation",
        prompt: "video",
        duration: 6,
        enable_audio: true,
      },
    ],
  ])(
    "submits %s through the shared normalized contract",
    async (path, body, normalized) => {
      const submitGeneration = vi.fn(async () => ({
        jobId,
        status: "queued" as const,
      }));
      const app = await createApp({ submitGeneration });

      const response = await app.inject({
        method: "POST",
        url: `/api/jobs/${path}`,
        payload: body,
      });

      expect(response.statusCode).toBe(201);
      expect(submitGeneration).toHaveBeenCalledWith(
        { userId: user.id, workspaceId, accessToken: user.accessToken },
        normalized,
      );
      await app.close();
    },
  );

  it("cancels a background job through CancelGeneration", async () => {
    const cancelGeneration = vi.fn(async () => ({
      jobId,
      status: "canceled" as const,
    }));
    const app = await createApp({ cancelGeneration });

    const response = await app.inject({
      method: "POST",
      url: `/api/jobs/${jobId}/cancel`,
    });

    expect(response.statusCode).toBe(200);
    expect(cancelGeneration).toHaveBeenCalledWith(
      { userId: user.id, workspaceId, accessToken: user.accessToken },
      { jobId },
    );
    await app.close();
  });
});

async function createApp(overrides: {
  submitGeneration?: (...args: never[]) => Promise<unknown>;
  cancelGeneration?: (...args: never[]) => Promise<unknown>;
}) {
  const app = Fastify();
  registerErrorHandler(app);
  await registerJobRoutes(app, {
    auth: { authenticate: async () => user },
    submitGeneration: (overrides.submitGeneration ?? vi.fn()) as never,
    cancelGeneration: (overrides.cancelGeneration ?? vi.fn()) as never,
    jobService: {
      getJob: async () => backgroundJob(),
      listJobs: async () => [],
    },
    viewerService: {
      ensureViewer: async () => ({ workspace: { id: workspaceId } }),
    } as never,
  });
  return app;
}

function backgroundJob() {
  return {
    id: jobId,
    workspace_id: workspaceId,
    project_id: null,
    canvas_id: null,
    session_id: null,
    thread_id: null,
    queue_name: "image_generation_jobs",
    job_type: "image_generation" as const,
    status: "queued" as const,
    payload: {},
    result: null,
    error_code: null,
    error_message: null,
    attempt_count: 0,
    max_attempts: 3,
    created_by: user.id,
    created_at: "2026-08-17T00:00:00.000Z",
    updated_at: "2026-08-17T00:00:00.000Z",
    started_at: null,
    completed_at: null,
    failed_at: null,
    canceled_at: null,
  };
}
