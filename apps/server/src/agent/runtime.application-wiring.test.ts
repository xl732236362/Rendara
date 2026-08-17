import { describe, expect, it, vi } from "vitest";

import { loadServerEnv } from "../config/env.js";
import { ProviderRegistry } from "../generation/providers/registry.js";
import { createAgentRunService } from "./runtime.js";
import type { SubmitImageJobFn } from "./tools/image-generate.js";
import { createMainAgentTools } from "./tools/index.js";
import type { SubmitVideoJobFn } from "./tools/video-generate.js";

describe("Agent runtime application wiring", () => {
  it("forwards canvas application dependencies to the resolved Agent factory", async () => {
    const applyCanvasOperations = vi.fn();
    const createUserClient = vi.fn(() => ({
      from: () => ({
        select: () => ({
          eq: () => ({
            limit: () => ({
              single: async () => ({
                data: { id: "workspace-1" },
                error: null,
              }),
            }),
          }),
        }),
      }),
    }));
    let factoryOptions: Record<string, unknown> | undefined;
    let toolNames: string[] = [];
    const service = createAgentRunService({
      agentFactory: ((options: Record<string, unknown>) => {
        factoryOptions = options;
        toolNames = createMainAgentTools(
          (options.backendResult as { factory: never }).factory,
          {
            applyCanvasOperations: options.applyCanvasOperations as never,
            createUserClient,
            providerRegistry: new ProviderRegistry().seal(),
            resolveWorkspaceId: options.resolveWorkspaceId as never,
          },
        ).map((registeredTool) => registeredTool.name);
        return {
          async *streamEvents() {},
          async *stream() {},
        };
      }) as never,
      applyCanvasOperations: applyCanvasOperations as never,
      createUserClient,
      env: loadServerEnv(
        { agentBackendMode: "filesystem", agentFilesRoot: process.cwd() },
        {},
      ),
      providerRegistry: new ProviderRegistry().seal(),
    });
    const run = service.createRun({
      conversationId: "conversation-1",
      prompt: "hello",
      sessionId: "session-1",
    });

    for await (const _event of service.streamRun(run.runId)) {
      // Consume the runtime so the lazy Agent factory is invoked.
    }

    expect(factoryOptions?.applyCanvasOperations).toBe(applyCanvasOperations);
    expect(factoryOptions?.resolveWorkspaceId).toBeTypeOf("function");
    expect(toolNames).toContain("manipulate_canvas");
    await expect(
      (
        factoryOptions?.resolveWorkspaceId as (token: string) => Promise<string>
      )("token"),
    ).resolves.toBe("workspace-1");
  });

  it("normalizes image and video tool submissions through the injected use case", async () => {
    const jobId = "33333333-3333-4333-8333-333333333333";
    const submitGeneration = vi.fn(async () => ({
      jobId,
      status: "queued" as const,
    }));
    let submitImageJob: SubmitImageJobFn | undefined;
    let submitVideoJob: SubmitVideoJobFn | undefined;
    const service = createAgentRunService({
      agentFactory: ((options: {
        submitImageJob?: SubmitImageJobFn;
        submitVideoJob?: SubmitVideoJobFn;
      }) => {
        submitImageJob = options.submitImageJob;
        submitVideoJob = options.submitVideoJob;
        return { async *streamEvents() {}, async *stream() {} };
      }) as never,
      createUserClient: (() => workspaceClient()) as never,
      env: loadServerEnv(
        { agentBackendMode: "filesystem", agentFilesRoot: process.cwd() },
        {},
      ),
      jobService: {
        getJobAdmin: async () => ({
          status: "succeeded",
          result: {
            signed_url: "https://example.com/result",
            object_path: "generated/result.png",
            width: 100,
            height: 80,
            mime_type: "image/png",
          },
        }),
      } as never,
      providerRegistry: new ProviderRegistry().seal(),
      submitGeneration,
    });
    const run = service.createRun(
      {
        conversationId: "conversation-1",
        prompt: "hello",
        sessionId: "session-1",
      },
      { accessToken: "token", userId: "11111111-1111-4111-8111-111111111111" },
    );
    for await (const _event of service.streamRun(run.runId)) {
      // Invoke the lazy Agent factory.
    }

    expect(submitImageJob).toBeTypeOf("function");
    expect(submitVideoJob).toBeTypeOf("function");
    if (!submitImageJob || !submitVideoJob)
      throw new Error("Generation tools were not wired");
    const imagePromise = submitImageJob({
      prompt: "image",
      title: "Image",
      model: "image/model",
      aspectRatio: "1:1",
      inputImages: ["https://example.com/input.png"],
    });
    await imagePromise;
    const videoPromise = submitVideoJob({
      prompt: "video",
      model: "video/model",
      duration: 6,
      resolution: "720p",
      aspectRatio: "16:9",
      enableAudio: true,
    });
    await videoPromise;

    expect(submitGeneration).toHaveBeenNthCalledWith(
      1,
      {
        userId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        accessToken: "token",
      },
      {
        type: "image_generation",
        prompt: "image",
        title: "Image",
        model: "image/model",
        aspect_ratio: "1:1",
        input_images: ["https://example.com/input.png"],
        session_id: "session-1",
      },
    );
    expect(submitGeneration).toHaveBeenNthCalledWith(
      2,
      {
        userId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        accessToken: "token",
      },
      {
        type: "video_generation",
        prompt: "video",
        model: "video/model",
        duration: 6,
        resolution: "720p",
        aspect_ratio: "16:9",
        enable_audio: true,
        session_id: "session-1",
      },
    );
  }, 10_000);
});

function workspaceClient() {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          limit: () => ({
            single: async () => ({
              data: { id: "22222222-2222-4222-8222-222222222222" },
              error: null,
            }),
          }),
        }),
      }),
    }),
  };
}
