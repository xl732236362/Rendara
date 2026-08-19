import { describe, expect, it, vi } from "vitest";

import { loadServerEnv } from "../config/env.js";
import { AppError } from "../errors/app-error.js";
import { MemoryAgentExecutionRepository } from "../features/agent-runs/agent-execution-repository.js";
import { ProviderRegistry } from "../generation/providers/registry.js";
import { createAgentRunService } from "./runtime.js";
import { createToolExecutionSupervisor } from "./tool-execution-supervisor.js";
import type { SubmitImageJobFn } from "./tools/image-generate.js";
import type { SubmitVideoJobFn } from "./tools/video-generate.js";

describe("Agent runtime application wiring", () => {
  it("closes an open tool before publishing the run terminal event", async () => {
    const supervisor = createToolExecutionSupervisor({
      agentRunId: "run-open-tool",
      attemptId: "attempt-open-tool",
      maxBytes: 10_000,
      maxCalls: 10,
    });
    const started = supervisor.stageStart({
      logicalToolCallId: "tool-open",
      toolName: "read_canvas",
      inputDigest: "digest-open",
    });
    supervisor.acknowledge(started);
    const service = createAgentRunService({
      agentFactory: (() => ({
        async *streamEvents() {},
        async *stream() {},
        toolSupervisor: supervisor,
      })) as never,
      env: loadServerEnv({}, {}),
      providerRegistry: new ProviderRegistry().seal(),
    });
    service.createRun(
      {
        canvasId: "canvas-open-tool",
        clientRequestId: "request-open-tool",
        conversationId: "conversation-open-tool",
        prompt: "hello",
        sessionId: "session-open-tool",
      },
      { runId: "run-open-tool" },
    );

    const events = [];
    for await (const event of service.streamRun("run-open-tool"))
      events.push(event);

    expect(events.slice(-2).map((event) => event.type)).toEqual([
      "tool.failed",
      "run.completed",
    ]);
  });

  it("fails a run when persistence initialization exceeds its deadline", async () => {
    vi.useFakeTimers();
    try {
      const service = createAgentRunService({
        agentPersistenceService: {
          getPersistence: vi.fn(() => new Promise<never>(() => undefined)),
        },
        env: loadServerEnv({}, {}),
        persistenceTimeoutMs: 10,
        providerRegistry: new ProviderRegistry().seal(),
      });
      service.createRun(
        {
          canvasId: "canvas-persistence-timeout",
          clientRequestId: "request-persistence-timeout",
          conversationId: "conversation-persistence-timeout",
          prompt: "hello",
          sessionId: "session-persistence-timeout",
        },
        { runId: "run-persistence-timeout", threadId: "thread-1" },
      );

      const eventPromise = service.streamRun("run-persistence-timeout").next();
      await vi.advanceTimersByTimeAsync(10);

      await expect(eventPromise).resolves.toMatchObject({
        value: {
          error: { code: "agent_persistence_timeout" },
          type: "run.failed",
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails a run when no model event arrives before its deadline", async () => {
    vi.useFakeTimers();
    try {
      const service = createAgentRunService({
        agentFactory: (() => ({
          async *streamEvents() {
            await new Promise(() => undefined);
          },
          async *stream() {},
        })) as never,
        env: loadServerEnv({}, {}),
        firstEventTimeoutMs: 30,
        providerRegistry: new ProviderRegistry().seal(),
      });
      service.createRun(
        {
          canvasId: "canvas-first-event-timeout",
          clientRequestId: "request-first-event-timeout",
          conversationId: "conversation-first-event-timeout",
          prompt: "hello",
          sessionId: "session-first-event-timeout",
        },
        { runId: "run-first-event-timeout" },
      );
      const events = service.streamRun("run-first-event-timeout");

      await expect(events.next()).resolves.toMatchObject({
        value: { type: "run.started" },
      });
      const eventPromise = events.next();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(30);

      await expect(eventPromise).resolves.toMatchObject({
        value: {
          error: { code: "agent_first_event_timeout" },
          type: "run.failed",
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns explicit ownership for created, active, and rehydrated runs", () => {
    const request = {
      canvasId: "canvas-ownership",
      clientRequestId: "request-ownership",
      conversationId: "conversation-ownership",
      prompt: "hello",
      sessionId: "session-ownership",
    };
    const activeService = createAgentRunService({
      env: loadServerEnv({}, {}),
      finalizationRetryDelayMs: 0,
      providerRegistry: new ProviderRegistry().seal(),
    });

    const created = activeService.registerRun(request, {
      durableCreated: true,
      runId: "run-ownership",
    });
    const existing = activeService.registerRun(request, {
      durableCreated: false,
      runId: "run-ownership",
    });

    expect(created.ownership).toBe("created");
    expect(existing).toMatchObject({
      ownership: "existing_active",
      response: { runId: "run-ownership" },
    });

    const coldService = createAgentRunService({
      env: loadServerEnv({}, {}),
      providerRegistry: new ProviderRegistry().seal(),
    });
    expect(
      coldService.registerRun(request, {
        durableCreated: false,
        runId: "run-ownership",
      }),
    ).toMatchObject({
      ownership: "rehydrated",
      response: { runId: "run-ownership" },
    });
  });

  it("replaces an expired running attempt before Agent construction", async () => {
    const repository = new MemoryAgentExecutionRepository();
    await repository.accept({
      clientRequestId: "request-resume",
      requestDigest: "digest-resume",
      context: {
        runId: "run-resume",
        attemptId: "attempt-stale",
        userId: "user-resume",
        workspaceId: "workspace-resume",
        projectId: "project-resume",
        canvasId: "canvas-resume",
        capabilities: ["image.generate"],
        capabilityPolicyVersion: "policy-1",
        skillCatalogDigest: "catalog-1",
        effectiveSkillNames: [],
      },
    });
    await repository.claimAttempt({
      attemptId: "attempt-stale",
      leaseOwner: "dead-worker",
      leaseMs: 1,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    const constructedAttempts: string[] = [];
    const service = createAgentRunService({
      agentExecutionRepository: repository,
      agentFactory: ((options: { executionContext: { attemptId: string } }) => {
        constructedAttempts.push(options.executionContext.attemptId);
        return { async *streamEvents() {}, async *stream() {} };
      }) as never,
      builtinSkillCatalog: {
        digest: "catalog-1",
        list: () => [],
      } as never,
      env: loadServerEnv({}, {}),
      now: () => "2026-01-01T00:01:00.000Z",
      providerRegistry: new ProviderRegistry().seal(),
    });
    service.createRun(
      {
        canvasId: "canvas-resume",
        clientRequestId: "request-resume",
        conversationId: "conversation-resume",
        prompt: "hello",
        sessionId: "session-resume",
      },
      { runId: "run-resume", userId: "user-resume" },
    );
    for await (const _event of service.streamRun("run-resume")) {
    }
    expect(constructedAttempts).toHaveLength(1);
    expect(constructedAttempts[0]).not.toBe("attempt-stale");
  });

  it("claims and atomically finalizes the persisted attempt before reporting completion", async () => {
    const repository = new MemoryAgentExecutionRepository();
    await repository.accept({
      clientRequestId: "request-lease",
      requestDigest: "digest-lease",
      context: {
        runId: "run-lease",
        attemptId: "attempt-lease",
        userId: "user-lease",
        workspaceId: "workspace-lease",
        projectId: "project-lease",
        canvasId: "canvas-lease",
        capabilities: ["image.generate"],
        capabilityPolicyVersion: "policy-1",
        skillCatalogDigest: "catalog-1",
        effectiveSkillNames: [],
      },
    });
    const constructionStates: boolean[] = [];
    const service = createAgentRunService({
      agentExecutionRepository: repository,
      agentFactory: (() => {
        constructionStates.push(
          Boolean(repository.get("run-lease")?.attempt.fencingToken),
        );
        return { async *streamEvents() {}, async *stream() {} };
      }) as never,
      env: loadServerEnv({}, {}),
      providerRegistry: new ProviderRegistry().seal(),
    });
    service.createRun(
      {
        canvasId: "canvas-lease",
        clientRequestId: "request-lease",
        conversationId: "conversation-lease",
        prompt: "hello",
        sessionId: "session-lease",
      },
      { runId: "run-lease", userId: "user-lease" },
    );

    for await (const _event of service.streamRun("run-lease")) {
    }
    expect(constructionStates).toEqual([true]);
    await service.cancelRun("run-lease");
    expect(repository.get("run-lease")).toMatchObject({
      runStatus: "completed",
      attempt: { status: "completed" },
    });
    await expect(
      repository.getExecutionContext("run-lease"),
    ).resolves.toBeNull();
  });

  it("emits no terminal event when persisted finalization is unconfirmed", async () => {
    const repository = new MemoryAgentExecutionRepository();
    await repository.accept({
      clientRequestId: "request-unconfirmed",
      requestDigest: "digest-unconfirmed",
      context: {
        runId: "run-unconfirmed",
        attemptId: "attempt-unconfirmed",
        userId: "user-unconfirmed",
        workspaceId: "workspace-unconfirmed",
        projectId: "project-unconfirmed",
        canvasId: "canvas-unconfirmed",
        capabilities: ["image.generate"],
        capabilityPolicyVersion: "policy-1",
        skillCatalogDigest: "catalog-1",
        effectiveSkillNames: [],
      },
    });
    vi.spyOn(repository, "finalizeRun").mockRejectedValue(
      new Error("agent_execution_persistence_failed"),
    );
    const service = createAgentRunService({
      agentExecutionRepository: repository,
      agentFactory: (() => ({
        async *streamEvents() {},
        async *stream() {},
      })) as never,
      env: loadServerEnv({}, {}),
      finalizationRetryDelayMs: 0,
      providerRegistry: new ProviderRegistry().seal(),
    });
    service.createRun(
      {
        canvasId: "canvas-unconfirmed",
        clientRequestId: "request-unconfirmed",
        conversationId: "conversation-unconfirmed",
        prompt: "hello",
        sessionId: "session-unconfirmed",
      },
      { runId: "run-unconfirmed", userId: "user-unconfirmed" },
    );
    const events: Array<{ type: string }> = [];

    const consume = async () => {
      for await (const event of service.streamRun("run-unconfirmed")) {
        events.push(event);
      }
    };
    await expect(consume()).rejects.toMatchObject({
      code: "run_finalization_unconfirmed",
    });
    expect(
      events.some((event) =>
        ["run.completed", "run.failed", "run.canceled"].includes(event.type),
      ),
    ).toBe(false);
  });

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
        logicalToolCallId: "tool-billing-image",
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
        logicalToolCallId: "tool-failing-image",
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
    const service = createAgentRunService({
      agentFactory: ((options: Record<string, unknown>) => {
        factoryOptions = options;
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
        logicalToolCallId: "tool-team-image",
        prompt: "image",
        title: "Image",
        model: "image/model",
        aspectRatio: "1:1",
      }),
    ).rejects.toThrow("stop before polling");
    await expect(
      submitVideoJob({
        logicalToolCallId: "tool-team-video",
        prompt: "video",
        model: "video/model",
      }),
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
        logicalToolCallId: "tool-foreign-image",
        prompt: "image",
        title: "Image",
        model: "image/model",
        aspectRatio: "1:1",
      }),
    ).rejects.toThrow("Canvas not found or access denied");
    await expect(
      submitVideoJob({
        logicalToolCallId: "tool-foreign-video",
        prompt: "video",
        model: "video/model",
      }),
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
      logicalToolCallId: "tool-image-1",
      prompt: "image",
      title: "Image",
      model: "image/model",
      quality: "ultra",
      aspectRatio: "1:1",
      inputImages: ["https://example.com/input.png"],
    });
    await imagePromise;
    const videoPromise = submitVideoJob({
      logicalToolCallId: "tool-video-1",
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

  it("rejects late generation after run finalization without mutating canvas", async () => {
    try {
      const repository = new MemoryAgentExecutionRepository();
      await repository.accept({
        clientRequestId: "request-generate-only",
        requestDigest: "digest-generate-only",
        context: {
          runId: "run-generate-only",
          attemptId: "attempt-generate-only",
          userId: "user-generate-only",
          workspaceId: "workspace-generate-only",
          projectId: "project-generate-only",
          canvasId: "canvas-generate-only",
          capabilities: ["image.generate"],
          capabilityPolicyVersion: "policy-1",
          skillCatalogDigest: "catalog-1",
          effectiveSkillNames: [],
        },
      });
      let submitImageJob: SubmitImageJobFn | undefined;
      const attachGeneratedAsset = vi.fn(async () => ({
        elementId: "element-1",
      }));
      const service = createAgentRunService({
        agentExecutionRepository: repository,
        agentFactory: ((options: { submitImageJob?: SubmitImageJobFn }) => {
          submitImageJob = options.submitImageJob;
          return { async *streamEvents() {}, async *stream() {} };
        }) as never,
        attachGeneratedAsset: attachGeneratedAsset as never,
        builtinSkillCatalog: { digest: "catalog-1", list: () => [] } as never,
        createUserClient: (() =>
          canvasWorkspaceClient({
            canvasId: "canvas-generate-only",
            workspaceId: "workspace-generate-only",
          })) as never,
        env: loadServerEnv({}, {}),
        jobService: {
          getJobAdmin: async () => ({
            status: "succeeded",
            result: {
              signed_url: "https://example.com/result.png",
              object_path: "generated/result.png",
              width: 100,
              height: 80,
              mime_type: "image/png",
            },
          }),
        } as never,
        providerRegistry: new ProviderRegistry().seal(),
        submitGeneration: vi.fn(async () => ({
          jobId: "job-generate-only",
          status: "queued" as const,
        })),
      });
      service.createRun(
        {
          canvasId: "canvas-generate-only",
          clientRequestId: "request-generate-only",
          conversationId: "conversation-generate-only",
          prompt: "generate",
          sessionId: "session-generate-only",
        },
        {
          accessToken: "token",
          runId: "run-generate-only",
          userId: "user-generate-only",
        },
      );
      for await (const _event of service.streamRun("run-generate-only")) {
      }
      if (!submitImageJob) throw new Error("Image tool was not wired");

      await expect(
        submitImageJob({
          logicalToolCallId: "tool-generate-only",
          prompt: "image",
          title: "Image",
          model: "image/model",
          aspectRatio: "1:1",
        }),
      ).rejects.toThrow("run_not_active");
      expect(attachGeneratedAsset).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
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
