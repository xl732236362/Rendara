import { describe, expect, it, vi } from "vitest";

import { loadServerEnv } from "../config/env.js";
import { AppError } from "../errors/app-error.js";
import { ProviderRegistry } from "../generation/providers/registry.js";
import { createAgentRunService } from "./runtime.js";
import type { SubmitImageJobFn } from "./tools/image-generate.js";
import { createMainAgentTools } from "./tools/index.js";
import type { SubmitVideoJobFn } from "./tools/video-generate.js";

describe("Agent runtime application wiring", () => {
  it("emits billing.error and aborts the run when submission is rejected for billing", async () => {
    let submitImageJob: SubmitImageJobFn | undefined;
    let runtimeSignal: AbortSignal | undefined;
    const pushToCanvas = vi.fn();
    const service = createAgentRunService({
      agentFactory: ((options: { submitImageJob?: SubmitImageJobFn }) => {
        submitImageJob = options.submitImageJob;
        return {
          async *streamEvents(
            _input: unknown,
            config: { signal?: AbortSignal },
          ) {
            runtimeSignal = config.signal;
            yield* [];
          },
          async *stream() {},
        };
      }) as never,
      connectionManager: { pushToCanvas } as never,
      createUserClient: (() =>
        canvasWorkspaceClient({
          canvasId: "canvas-1",
          workspaceId: "workspace-1",
        })) as never,
      env: loadServerEnv({}, {}),
      jobService: {} as never,
      providerRegistry: new ProviderRegistry().seal(),
      submitGeneration: vi.fn(async () => {
        throw new AppError({
          code: "insufficient_credits",
          statusCode: 402,
          message: "Not enough credits",
          expose: true,
          details: {
            balance: 2,
            requiredAmount: 7,
            plan: "free",
            dailyClaimed: true,
            secret: "hidden",
          },
        });
      }),
    });
    const run = service.createRun(
      {
        canvasId: "canvas-1",
        clientRequestId: "request-1",
        conversationId: "conversation-1",
        prompt: "hello",
        sessionId: "session-1",
      },
      { accessToken: "token", userId: "11111111-1111-4111-8111-111111111111" },
    );
    for await (const _event of service.streamRun(run.runId)) {
    }
    if (!submitImageJob) throw new Error("Image tool was not wired");

    await expect(
      submitImageJob({
        prompt: "image",
        title: "Image",
        model: "image/model",
        aspectRatio: "1:1",
      }),
    ).rejects.toMatchObject({ code: "insufficient_credits" });
    expect(pushToCanvas).toHaveBeenCalledWith(
      "canvas-1",
      expect.objectContaining({
        type: "billing.error",
        runId: run.runId,
        code: "insufficient_credits",
        message: "Not enough credits",
        currentBalance: 2,
        requiredAmount: 7,
        plan: "free",
        dailyClaimed: true,
      }),
    );
    expect(pushToCanvas.mock.calls[0]?.[1]).not.toHaveProperty("secret");
    expect(runtimeSignal?.aborted).toBe(true);
  });

  it("keeps non-billing submission failures as tool errors without aborting", async () => {
    let submitImageJob: SubmitImageJobFn | undefined;
    let runtimeSignal: AbortSignal | undefined;
    const pushToCanvas = vi.fn();
    const service = createAgentRunService({
      agentFactory: ((options: { submitImageJob?: SubmitImageJobFn }) => {
        submitImageJob = options.submitImageJob;
        return {
          async *streamEvents(
            _input: unknown,
            config: { signal?: AbortSignal },
          ) {
            runtimeSignal = config.signal;
            yield* [];
          },
          async *stream() {},
        };
      }) as never,
      connectionManager: { pushToCanvas } as never,
      createUserClient: (() =>
        canvasWorkspaceClient({
          canvasId: "canvas-1",
          workspaceId: "workspace-1",
        })) as never,
      env: loadServerEnv({}, {}),
      jobService: {} as never,
      providerRegistry: new ProviderRegistry().seal(),
      submitGeneration: vi.fn(async () => {
        throw new AppError({
          code: "application_error",
          statusCode: 500,
          message: "Internal failure",
        });
      }),
    });
    const run = service.createRun(
      {
        canvasId: "canvas-1",
        clientRequestId: "request-2",
        conversationId: "conversation-1",
        prompt: "hello",
        sessionId: "session-1",
      },
      { accessToken: "token", userId: "11111111-1111-4111-8111-111111111111" },
    );
    for await (const _event of service.streamRun(run.runId)) {
    }
    if (!submitImageJob) throw new Error("Image tool was not wired");

    await expect(
      submitImageJob({
        prompt: "image",
        title: "Image",
        model: "image/model",
        aspectRatio: "1:1",
      }),
    ).rejects.toMatchObject({ code: "application_error" });
    expect(pushToCanvas).not.toHaveBeenCalled();
    expect(runtimeSignal?.aborted).toBe(false);
  });
  it("forwards canvas application dependencies to the resolved Agent factory", async () => {
    const applyCanvasOperations = vi.fn();
    const createUserClient = vi.fn(() => ({
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                id: "canvas-team",
                project_id: "project-team",
                projects: { workspace_id: "workspace-team" },
              },
              error: null,
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
        toolNames = createMainAgentTools({
          applyCanvasOperations: options.applyCanvasOperations as never,
          createUserClient,
          providerRegistry: new ProviderRegistry().seal(),
          resolveWorkspaceId: options.resolveWorkspaceId as never,
        }).map((registeredTool) => registeredTool.name);
        return {
          async *streamEvents() {},
          async *stream() {},
        };
      }) as never,
      applyCanvasOperations: applyCanvasOperations as never,
      createUserClient,
      env: loadServerEnv({}, {}),
      providerRegistry: new ProviderRegistry().seal(),
    });
    const run = service.createRun({
      canvasId: "canvas-team",
      clientRequestId: "request-3",
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
        factoryOptions?.resolveWorkspaceId as (context: {
          accessToken: string;
          userId: string;
          canvasId: string;
        }) => Promise<string>
      )({ accessToken: "token", userId: "user-team", canvasId: "canvas-team" }),
    ).resolves.toBe("workspace-team");
    await expect(
      (
        factoryOptions?.resolveWorkspaceId as (context: {
          accessToken: string;
          userId: string;
          canvasId: string;
        }) => Promise<string>
      )({
        accessToken: "token",
        userId: "user-team",
        canvasId: "canvas-other",
      }),
    ).rejects.toThrow("Canvas not found or access denied");
  });

  it("uses one team-canvas workspace resolution for image and video submissions", async () => {
    let submitImageJob: SubmitImageJobFn | undefined;
    let submitVideoJob: SubmitVideoJobFn | undefined;
    const canvasWorkspaceLookups: string[] = [];
    const createUserClient = vi.fn(() =>
      canvasWorkspaceClient({
        canvasId: "canvas-team",
        workspaceId: "workspace-team",
        onSelect: (columns) => canvasWorkspaceLookups.push(columns),
      }),
    );
    const submitGeneration = vi.fn(
      async (_principal: unknown, _request: unknown) => {
        throw new Error("stop before polling");
      },
    );
    const service = createAgentRunService({
      agentFactory: ((options: {
        submitImageJob?: SubmitImageJobFn;
        submitVideoJob?: SubmitVideoJobFn;
      }) => {
        submitImageJob = options.submitImageJob;
        submitVideoJob = options.submitVideoJob;
        return { async *streamEvents() {}, async *stream() {} };
      }) as never,
      createUserClient: createUserClient as never,
      env: loadServerEnv({}, {}),
      jobService: {} as never,
      providerRegistry: new ProviderRegistry().seal(),
      submitGeneration,
    });
    const run = service.createRun(
      {
        canvasId: "canvas-team",
        clientRequestId: "request-4",
        conversationId: "conversation-1",
        prompt: "hello",
        sessionId: "session-1",
      },
      { accessToken: "token", userId: "user-team" },
    );
    for await (const _event of service.streamRun(run.runId)) {
    }
    if (!submitImageJob || !submitVideoJob) throw new Error("Tools not wired");

    await expect(
      submitImageJob({
        prompt: "image",
        title: "Image",
        model: "image/model",
        aspectRatio: "1:1",
      }),
    ).rejects.toThrow("stop before polling");
    await expect(
      submitVideoJob({ prompt: "video", model: "video/model" }),
    ).rejects.toThrow("stop before polling");

    expect(submitGeneration).toHaveBeenCalledTimes(2);
    expect(submitGeneration.mock.calls.map((call) => call[0])).toEqual([
      {
        userId: "user-team",
        workspaceId: "workspace-team",
        accessToken: "token",
      },
      {
        userId: "user-team",
        workspaceId: "workspace-team",
        accessToken: "token",
      },
    ]);
    expect(
      canvasWorkspaceLookups.filter((columns) =>
        columns.includes("projects!inner(workspace_id)"),
      ),
    ).toHaveLength(1);
  });

  it("rejects a missing or foreign canvas before either generation submission", async () => {
    let submitImageJob: SubmitImageJobFn | undefined;
    let submitVideoJob: SubmitVideoJobFn | undefined;
    const submitGeneration = vi.fn();
    const service = createAgentRunService({
      agentFactory: ((options: {
        submitImageJob?: SubmitImageJobFn;
        submitVideoJob?: SubmitVideoJobFn;
      }) => {
        submitImageJob = options.submitImageJob;
        submitVideoJob = options.submitVideoJob;
        return { async *streamEvents() {}, async *stream() {} };
      }) as never,
      createUserClient: (() =>
        canvasWorkspaceClient({ canvasId: null, workspaceId: null })) as never,
      env: loadServerEnv({}, {}),
      jobService: {} as never,
      providerRegistry: new ProviderRegistry().seal(),
      submitGeneration,
    });
    const run = service.createRun(
      {
        canvasId: "canvas-foreign",
        clientRequestId: "request-5",
        conversationId: "conversation-1",
        prompt: "hello",
        sessionId: "session-1",
      },
      { accessToken: "token", userId: "user-1" },
    );
    for await (const _event of service.streamRun(run.runId)) {
    }
    if (!submitImageJob || !submitVideoJob) throw new Error("Tools not wired");

    await expect(
      submitImageJob({
        prompt: "image",
        title: "Image",
        model: "image/model",
        aspectRatio: "1:1",
      }),
    ).rejects.toThrow("Canvas not found or access denied");
    await expect(
      submitVideoJob({ prompt: "video", model: "video/model" }),
    ).rejects.toThrow("Canvas not found or access denied");
    expect(submitGeneration).not.toHaveBeenCalled();
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
      createUserClient: (() =>
        canvasWorkspaceClient({
          canvasId: "canvas-1",
          workspaceId: "22222222-2222-4222-8222-222222222222",
        })) as never,
      env: loadServerEnv({}, {}),
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
        canvasId: "canvas-1",
        clientRequestId: "request-6",
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
      quality: "ultra",
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
        idempotency_key: expect.stringMatching(
          /^agent:[^:]+:image:[0-9a-f]{32}$/,
        ),
        canvas_id: "canvas-1",
        type: "image_generation",
        prompt: "image",
        title: "Image",
        model: "image/model",
        quality: "ultra",
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
        idempotency_key: expect.stringMatching(
          /^agent:[^:]+:video:[0-9a-f]{32}$/,
        ),
        canvas_id: "canvas-1",
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
          maybeSingle: async () => ({ data: null, error: null }),
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

function canvasWorkspaceClient(options: {
  canvasId: string | null;
  workspaceId: string | null;
  onSelect?: (columns: string) => void;
}) {
  return {
    from: () => ({
      select: (columns: string) => {
        options.onSelect?.(columns);
        return {
          eq: () => ({
            maybeSingle: async () => ({
              data:
                options.canvasId && options.workspaceId
                  ? {
                      id: options.canvasId,
                      project_id: "project-team",
                      projects: { workspace_id: options.workspaceId },
                    }
                  : null,
              error: null,
            }),
          }),
        };
      },
    }),
  };
}
