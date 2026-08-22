import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { AgentRunError } from "../application/agent/agent-run-errors.js";
import { AgentFinalizationUnconfirmedError } from "../features/agent-runs/agent-run-service.js";
import {
  type ResourceAuthorization,
  ResourceAuthorizationError,
} from "../security/resource-authorization.js";
import type { AuthenticatedUser } from "../supabase/user.js";
import { ConnectionManager } from "./connection-manager.js";
import { CanvasEventBuffer } from "./event-buffer.js";
import {
  authorizeCanvasResume,
  authorizeRunCancel,
  authorizeRunResources,
  bindAuthenticatedSocket,
  toRecoveryAssistantPayload,
} from "./handler.js";

const user: AuthenticatedUser = {
  accessToken: "token",
  email: "designer@example.com",
  id: "user-1",
  userMetadata: {},
};

describe("WebSocket run authorization", () => {
  it("accepts a run when its session and requested canvas match", async () => {
    const authorization = fakeAuthorization("canvas-1");

    await expect(
      authorizeRunResources(authorization, user, {
        canvasId: "canvas-1",
        conversationId: "canvas-1",
        sessionId: "session-1",
      }),
    ).resolves.toBe("canvas-1");
  });

  it("rejects a run when the requested canvas differs from the session canvas", async () => {
    const authorization = fakeAuthorization("canvas-1");

    await expect(
      authorizeRunResources(authorization, user, {
        canvasId: "other-canvas",
        conversationId: "other-canvas",
        sessionId: "session-1",
      }),
    ).rejects.toMatchObject({ code: "forbidden", statusCode: 403 });
  });
});

describe("WebSocket resource commands", () => {
  it("deep-bounds tool fields in assistant recovery payloads", () => {
    const payload = toRecoveryAssistantPayload(
      [],
      [
        {
          type: "tool",
          toolCallId: "tool-1",
          toolName: "tool",
          status: "completed",
          output: { giant: "x".repeat(20_000) },
        },
      ],
    );

    expect(JSON.stringify(payload).length).toBeLessThan(10_000);
    expect(
      (payload.contentBlocks[0] as { output?: { giant?: string } }).output,
    ).toMatchObject({ giant: expect.stringContaining("truncated") });
  });
  it("includes the active run session in the canvas resume acknowledgement", async () => {
    const socket = new FakeSocket();
    const connectionManager = new ConnectionManager();
    connectionManager.setActiveRun("canvas-1", "run-active", "session-active");

    await bindAuthenticatedSocket(
      socket as never,
      "token",
      { url: "/api/ws", headers: { host: "localhost" } } as never,
      {
        agentRuns: fakeAgentRuns() as never,
        authorization: fakeAuthorization("canvas-1"),
        auth: { authenticate: async () => user },
        connectionManager,
      },
    );
    socket.emit(
      "message",
      JSON.stringify({
        type: "command",
        action: "canvas.resume",
        payload: { canvasId: "canvas-1", lastSeq: 0 },
      }),
    );
    await nextTurn();

    expect(
      socket.messages.map((message) => JSON.parse(message)),
    ).toContainEqual(
      expect.objectContaining({
        action: "canvas.resume",
        payload: expect.objectContaining({
          activeRunId: "run-active",
          activeRunSessionId: "session-active",
        }),
        type: "command.ack",
      }),
    );
    socket.emit("close");
  });

  it("uses persisted active run state when resuming on another replica", async () => {
    const socket = new FakeSocket();
    const connectionManager = new ConnectionManager();
    const getActiveRunByCanvas = vi.fn().mockResolvedValue({
      runId: "run-on-replica-a",
      sessionId: "session-active",
    });

    await bindAuthenticatedSocket(
      socket as never,
      "token",
      { url: "/api/ws", headers: { host: "localhost" } } as never,
      {
        activeRunLookup: { getActiveRunByCanvas },
        agentRuns: fakeAgentRuns() as never,
        authorization: fakeAuthorization("canvas-1"),
        auth: { authenticate: async () => user },
        connectionManager,
      },
    );
    socket.emit(
      "message",
      JSON.stringify({
        type: "command",
        action: "canvas.resume",
        payload: { canvasId: "canvas-1", lastSeq: 0 },
      }),
    );
    await nextTurn();

    expect(getActiveRunByCanvas).toHaveBeenCalledWith("canvas-1");
    expect(
      socket.messages.map((message) => JSON.parse(message)),
    ).toContainEqual(
      expect.objectContaining({
        action: "canvas.resume",
        payload: expect.objectContaining({
          activeRunId: "run-on-replica-a",
          activeRunSessionId: "session-active",
        }),
        type: "command.ack",
      }),
    );
    socket.emit("close");
  });

  it("restarts a recoverable run after canvas resume", async () => {
    const socket = new FakeSocket();
    const agentRuns = fakeAgentRuns();
    agentRuns.registerRun.mockReturnValue({
      ownership: "existing_active",
      response: {
        conversationId: "conversation-1",
        runId: "run-active",
        sessionId: "session-1",
        status: "accepted",
      },
    });
    agentRuns.isRunRecoverable.mockReturnValue(true);
    agentRuns.getRunRequest.mockReturnValue({
      canvasId: "canvas-1",
      clientRequestId: "request-1",
      conversationId: "conversation-1",
      prompt: "resume me",
      sessionId: "session-1",
    });
    agentRuns.streamRun.mockReturnValue(
      (async function* () {
        yield {
          type: "run.completed",
          runId: "run-active",
          timestamp: new Date().toISOString(),
        };
      })(),
    );
    const connectionManager = new ConnectionManager();
    connectionManager.setActiveRun("canvas-1", "run-active", "session-1");

    await bindAuthenticatedSocket(
      socket as never,
      "token",
      { url: "/api/ws", headers: { host: "localhost" } } as never,
      {
        agentRuns: agentRuns as never,
        authorization: fakeAuthorization("canvas-1"),
        auth: { authenticate: async () => user },
        connectionManager,
        prepareAgentRun: async () => preparedRun(false),
      },
    );
    socket.emit(
      "message",
      JSON.stringify({
        type: "command",
        action: "canvas.resume",
        payload: { canvasId: "canvas-1", lastSeq: 0 },
      }),
    );
    await nextTurn();
    await nextTurn();

    expect(agentRuns.streamRun).toHaveBeenCalledOnce();
    socket.emit("close");
  });

  it("acknowledges an active replay without consuming or clearing its stream", async () => {
    const socket = new FakeSocket();
    const agentRuns = fakeAgentRuns();
    agentRuns.registerRun.mockReturnValue({
      ownership: "existing_active",
      response: {
        conversationId: "conversation-1",
        runId: "run-1",
        sessionId: "session-1",
        status: "accepted",
      },
    });
    const connectionManager = new ConnectionManager();
    const clearActiveRun = vi.spyOn(connectionManager, "clearActiveRun");

    await bindAuthenticatedSocket(
      socket as never,
      "token",
      { url: "/api/ws", headers: { host: "localhost" } } as never,
      {
        agentRuns: agentRuns as never,
        authorization: fakeAuthorization("canvas-1"),
        auth: { authenticate: async () => user },
        connectionManager,
        prepareAgentRun: async () => preparedRun(false),
      },
    );
    socket.emit("message", runCommand());
    await nextTurn();

    expect(agentRuns.streamRun).not.toHaveBeenCalled();
    expect(clearActiveRun).not.toHaveBeenCalled();
    expect(
      socket.messages.map((message) => JSON.parse(message)),
    ).toContainEqual(
      expect.objectContaining({
        action: "agent.run",
        payload: expect.objectContaining({
          clientRequestId: "request-1",
          runId: "run-1",
        }),
        type: "command.ack",
      }),
    );
    socket.emit("close");
  });

  it("replays a recoverable active run once when ownership is existing", async () => {
    const socket = new FakeSocket();
    const agentRuns = fakeAgentRuns();
    agentRuns.registerRun.mockReturnValue({
      ownership: "existing_active",
      response: {
        conversationId: "conversation-1",
        runId: "run-1",
        sessionId: "session-1",
        status: "accepted",
      },
    });
    agentRuns.isRunRecoverable.mockReturnValue(true);
    agentRuns.streamRun.mockReturnValue(
      (async function* () {
        yield {
          type: "run.completed",
          runId: "run-1",
          timestamp: new Date().toISOString(),
        };
      })(),
    );
    const connectionManager = new ConnectionManager();

    await bindAuthenticatedSocket(
      socket as never,
      "token",
      { url: "/api/ws", headers: { host: "localhost" } } as never,
      {
        agentRuns: agentRuns as never,
        authorization: fakeAuthorization("canvas-1"),
        auth: { authenticate: async () => user },
        connectionManager,
        prepareAgentRun: async () => preparedRun(false),
      },
    );
    socket.emit("message", runCommand());
    await nextTurn();
    await nextTurn();

    expect(agentRuns.streamRun).toHaveBeenCalledOnce();
    expect(connectionManager.getActiveRun("canvas-1")).toBeNull();
    socket.emit("close");
  });

  it("marks a newly owned run active before sending its acknowledgement", async () => {
    const socket = new FakeSocket();
    const agentRuns = fakeAgentRuns();
    agentRuns.registerRun.mockReturnValue({
      ownership: "created",
      response: {
        conversationId: "conversation-1",
        runId: "run-1",
        sessionId: "session-1",
        status: "accepted",
      },
    });
    agentRuns.streamRun.mockReturnValue((async function* () {})());
    const connectionManager = new ConnectionManager();
    const setActiveRun = vi.spyOn(connectionManager, "setActiveRun");
    const sendTo = vi.spyOn(connectionManager, "sendTo");
    const prepareAgentRun = vi.fn(async () => preparedRun(true));
    const agentRunStageLogger = {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };

    await bindAuthenticatedSocket(
      socket as never,
      "token",
      {
        id: "ws-request-1",
        url: "/api/ws",
        headers: { host: "localhost" },
      } as never,
      {
        agentRuns: agentRuns as never,
        agentRunStageLogger,
        authorization: fakeAuthorization("canvas-1"),
        auth: { authenticate: async () => user },
        connectionManager,
        prepareAgentRun,
      },
    );
    socket.emit("message", runCommand());
    await nextTurn();

    expect(setActiveRun.mock.invocationCallOrder[0]).toBeLessThan(
      sendTo.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(agentRuns.streamRun).toHaveBeenCalledOnce();
    expect(prepareAgentRun).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      { requestId: "ws-request-1" },
    );
    expect(agentRunStageLogger.info).toHaveBeenCalledWith(
      "agent.ack.completed",
      expect.objectContaining({
        clientRequestId: "request-1",
        requestId: "ws-request-1",
        runId: "run-1",
      }),
    );
    socket.emit("close");
  });

  it("persists terminal tool events, including terminals received without a start", async () => {
    const socket = new FakeSocket();
    const agentRuns = fakeAgentRuns();
    agentRuns.registerRun.mockReturnValue({
      ownership: "created",
      response: {
        conversationId: "conversation-1",
        runId: "run-1",
        sessionId: "session-1",
        status: "accepted",
      },
    });
    agentRuns.streamRun.mockReturnValue(
      (async function* () {
        yield {
          type: "tool.started",
          runId: "run-1",
          toolCallId: "started-call",
          toolName: "inspect_canvas",
          timestamp: "2026-08-20T00:00:00.000Z",
        };
        yield {
          type: "tool.failed",
          runId: "run-1",
          toolCallId: "started-call",
          toolName: "inspect_canvas",
          error: {
            code: "element_not_found",
            message: "Element not found.",
            correlationId: "correlation-1",
          },
          timestamp: "2026-08-20T00:00:01.000Z",
        };
        yield {
          type: "tool.completed",
          runId: "run-1",
          toolCallId: "terminal-only-call",
          toolName: "generate_image",
          output: { elementId: "element-1" },
          outputSummary: "Generated media is ready.",
          artifacts: Array.from({ length: 11 }, (_, index) => ({
            type: "image",
            url: `https://example.com/generated-${index}.png`,
            mimeType: "image/png",
            width: 512,
            height: 512,
          })),
          timestamp: "2026-08-20T00:00:02.000Z",
        };
        yield {
          type: "tool.failed",
          runId: "run-1",
          toolCallId: "failed-terminal-only-call",
          toolName: "generate_video",
          error: {
            code: "tool_failed",
            message: "Generation failed.",
            correlationId: "correlation-2",
          },
          timestamp: "2026-08-20T00:00:03.000Z",
        };
      })(),
    );
    const createMessage = vi.fn();

    await bindAuthenticatedSocket(
      socket as never,
      "token",
      { url: "/api/ws", headers: { host: "localhost" } } as never,
      {
        agentRuns: agentRuns as never,
        authorization: fakeAuthorization("canvas-1"),
        auth: { authenticate: async () => user },
        chatService: { createMessage } as never,
        connectionManager: new ConnectionManager(),
        prepareAgentRun: async () => preparedRun(true),
      },
    );
    socket.emit("message", runCommand());
    await nextTurn();
    await nextTurn();

    expect(createMessage).toHaveBeenCalledWith(
      user,
      "session-1",
      expect.objectContaining({
        role: "assistant",
        contentBlocks: [
          expect.objectContaining({
            toolCallId: "started-call",
            status: "failed",
            error: expect.objectContaining({ code: "element_not_found" }),
          }),
          expect.objectContaining({
            toolCallId: "terminal-only-call",
            status: "completed",
            output: { elementId: "element-1" },
            outputSummary: "Generated media is ready.",
            artifacts: expect.arrayContaining([
              expect.objectContaining({ type: "image" }),
            ]),
          }),
          expect.objectContaining({
            toolCallId: "failed-terminal-only-call",
            status: "failed",
            error: expect.objectContaining({ code: "tool_failed" }),
          }),
        ],
      }),
    );
    const persisted = createMessage.mock.calls[0]?.[2];
    const terminalOnlyBlock = persisted?.contentBlocks?.find(
      (block: { toolCallId?: string }) =>
        block.toolCallId === "terminal-only-call",
    );
    expect(terminalOnlyBlock?.artifacts).toHaveLength(10);
    socket.emit("close");
  });

  it("retries a transient assistant persistence failure and saves the response", async () => {
    const socket = new FakeSocket();
    const agentRuns = createdAgentRuns(
      (async function* () {
        yield {
          type: "message.delta",
          runId: "run-1",
          messageId: "message-1",
          delta: "Saved response.",
          timestamp: "2026-08-20T00:00:00.000Z",
        };
      })(),
    );
    const createMessage = vi
      .fn()
      // Model an insert that may have committed before its response was lost.
      .mockRejectedValueOnce(new Error("post_insert_response_lost"))
      .mockResolvedValueOnce(undefined);

    await bindWithCreatedRun(socket, agentRuns, {
      chatService: { createMessage } as never,
    });
    socket.emit("message", runCommand());
    await waitForTurns(8);

    expect(createMessage).toHaveBeenCalledTimes(2);
    expect(createMessage.mock.calls[0]?.[2].id).toBe(
      createMessage.mock.calls[1]?.[2].id,
    );
    expect(createMessage.mock.calls[0]?.[2].id).toBe("run-1");
    expect(createMessage).toHaveBeenLastCalledWith(
      user,
      "session-1",
      expect.objectContaining({
        content: "Saved response.",
        contentBlocks: [{ type: "text", text: "Saved response." }],
        role: "assistant",
      }),
    );
    socket.emit("close");
  });

  it("emits an assistant persistence failure after bounded retries", async () => {
    const socket = new FakeSocket();
    const agentRuns = createdAgentRuns(
      (async function* () {
        yield {
          type: "message.delta",
          runId: "run-1",
          messageId: "message-1",
          delta: "Unsaved response.",
          timestamp: "2026-08-20T00:00:00.000Z",
        };
        yield {
          type: "run.failed",
          runId: "run-1",
          error: { code: "run_failed", message: "Agent execution failed." },
          timestamp: "2026-08-20T00:00:01.000Z",
        };
      })(),
    );
    const createMessage = vi.fn().mockRejectedValue(new Error("database_down"));

    await bindWithCreatedRun(socket, agentRuns, {
      chatService: { createMessage } as never,
    });
    socket.emit("message", runCommand());
    await waitForTurns(12);

    expect(createMessage).toHaveBeenCalledTimes(3);
    const messages = socket.messages.map((message) => JSON.parse(message));
    expect(messages).toContainEqual(
      expect.objectContaining({
        action: "agent.run",
        clientRequestId: "request-1",
        runId: "run-1",
        type: "error",
        error: expect.objectContaining({
          code: "assistant_message_persistence_failed",
        }),
      }),
    );
    const persistenceErrorIndex = messages.findIndex(
      (message) =>
        message.type === "error" &&
        message.error?.code === "assistant_message_persistence_failed",
    );
    const terminalFailureIndex = messages.findIndex(
      (message) =>
        message.type === "event" && message.event?.type === "run.failed",
    );
    expect(persistenceErrorIndex).toBeGreaterThan(-1);
    expect(terminalFailureIndex).toBeGreaterThan(persistenceErrorIndex);
    socket.emit("close");
  });

  it("publishes a replayable persistence failure before a completed run", async () => {
    const socket = new FakeSocket();
    const eventBuffer = new CanvasEventBuffer();
    const agentRuns = createdAgentRuns(
      (async function* () {
        yield {
          type: "message.delta",
          runId: "run-1",
          messageId: "message-1",
          delta: "Unsaved completed response.",
          timestamp: "2026-08-20T00:00:00.000Z",
        };
        yield {
          type: "run.completed",
          runId: "run-1",
          timestamp: "2026-08-20T00:00:01.000Z",
        };
      })(),
    );
    const createMessage = vi.fn().mockRejectedValue(new Error("database_down"));

    await bindWithCreatedRun(socket, agentRuns, {
      chatService: { createMessage } as never,
      eventBuffer,
    });
    socket.emit("message", runCommand());
    await waitForTurns(12);

    const messages = socket.messages.map((message) => JSON.parse(message));
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "event",
        seq: 1,
        event: expect.objectContaining({
          type: "message.delta",
          delta: "Unsaved completed response.",
        }),
      }),
    );
    const persistenceSignalIndex = messages.findIndex(
      (message) =>
        message.type === "event" &&
        message.event?.type === "assistant.persistence_failed",
    );
    const completedIndex = messages.findIndex(
      (message) =>
        message.type === "event" && message.event?.type === "run.completed",
    );
    expect(persistenceSignalIndex).toBeGreaterThan(-1);
    expect(completedIndex).toBeGreaterThan(persistenceSignalIndex);
    expect(
      eventBuffer
        .getAfter("canvas-1")
        .map(({ event }) => event.type)
        .slice(-2),
    ).toEqual(["assistant.persistence_failed", "run.completed"]);
    const persistenceMarker = eventBuffer
      .getAfter("canvas-1")
      .find(({ event }) => event.type === "assistant.persistence_failed");
    expect(persistenceMarker?.event).toMatchObject({
      sessionId: "session-1",
      assistant: {
        content: "Unsaved completed response.",
        contentBlocks: [{ type: "text", text: "Unsaved completed response." }],
      },
    });
    socket.emit("close");
  });

  it("replays buffered event sequences and uses the same sequence for live delivery", async () => {
    const socket = new FakeSocket();
    const eventBuffer = new CanvasEventBuffer();
    eventBuffer.push("canvas-1", {
      type: "message.delta",
      runId: "run-1",
      messageId: "message-1",
      delta: "first",
      timestamp: "2026-08-20T00:00:00.000Z",
    });
    eventBuffer.push("canvas-1", {
      type: "message.delta",
      runId: "run-1",
      messageId: "message-1",
      delta: "second",
      timestamp: "2026-08-20T00:00:01.000Z",
    });
    const connectionManager = new ConnectionManager();

    await bindAuthenticatedSocket(
      socket as never,
      "token",
      { url: "/api/ws", headers: { host: "localhost" } } as never,
      {
        agentRuns: fakeAgentRuns() as never,
        authorization: fakeAuthorization("canvas-1"),
        auth: { authenticate: async () => user },
        connectionManager,
        eventBuffer,
      },
    );
    socket.emit(
      "message",
      JSON.stringify({
        type: "command",
        action: "canvas.resume",
        payload: { canvasId: "canvas-1", lastSeq: 1 },
      }),
    );
    await nextTurn();

    const replay = socket.messages
      .map((message) => JSON.parse(message))
      .find((message) => message.type === "event");
    expect(replay).toMatchObject({
      seq: 2,
      event: { type: "message.delta", delta: "second" },
    });
    socket.emit("close");
  });

  it("acknowledges replay gaps without sending a partial tail", async () => {
    const socket = new FakeSocket();
    const eventBuffer = new CanvasEventBuffer({ maxPerCanvas: 1 });
    eventBuffer.push("canvas-1", {
      type: "message.delta",
      runId: "run-1",
      messageId: "message-1",
      delta: "old",
      timestamp: "2026-08-20T00:00:00.000Z",
    });
    eventBuffer.push("canvas-1", {
      type: "message.delta",
      runId: "run-1",
      messageId: "message-1",
      delta: "new",
      timestamp: "2026-08-20T00:00:01.000Z",
    });
    eventBuffer.push("canvas-1", {
      type: "message.delta",
      runId: "run-1",
      messageId: "message-1",
      delta: "latest",
      timestamp: "2026-08-20T00:00:02.000Z",
    });

    await bindAuthenticatedSocket(
      socket as never,
      "token",
      { url: "/api/ws", headers: { host: "localhost" } } as never,
      {
        agentRuns: fakeAgentRuns() as never,
        authorization: fakeAuthorization("canvas-1"),
        auth: { authenticate: async () => user },
        connectionManager: new ConnectionManager(),
        eventBuffer,
      },
    );
    socket.emit(
      "message",
      JSON.stringify({
        type: "command",
        action: "canvas.resume",
        payload: { canvasId: "canvas-1", lastSeq: 1 },
      }),
    );
    await nextTurn();

    const messages = socket.messages.map((message) => JSON.parse(message));
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "command.ack",
        payload: expect.objectContaining({ replayGap: true }),
      }),
    );
    expect(messages.some((message) => message.type === "event")).toBe(false);

    socket.emit("close");
  });

  it("persists a run failure received before text or tool events", async () => {
    const socket = new FakeSocket();
    const agentRuns = createdAgentRuns(
      (async function* () {
        yield {
          type: "run.failed",
          runId: "run-1",
          error: { code: "run_failed", message: "Agent execution failed." },
          timestamp: "2026-08-20T00:00:00.000Z",
        };
      })(),
    );
    const createMessage = vi.fn();

    await bindWithCreatedRun(socket, agentRuns, {
      chatService: { createMessage } as never,
    });
    socket.emit("message", runCommand());
    await nextTurn();
    await nextTurn();

    expect(createMessage).toHaveBeenCalledWith(
      user,
      "session-1",
      expect.objectContaining({
        content: "抱歉，处理过程中遇到问题，请重试。",
        contentBlocks: [
          { type: "text", text: "抱歉，处理过程中遇到问题，请重试。" },
        ],
        role: "assistant",
      }),
    );
    socket.emit("close");
  });

  it("persists ordered thinking blocks from the Agent stream", async () => {
    const socket = new FakeSocket();
    const agentRuns = createdAgentRuns(
      (async function* () {
        yield {
          type: "thinking.delta",
          runId: "run-1",
          messageId: "message-1",
          delta: "Consider the composition.",
          timestamp: "2026-08-20T00:00:00.000Z",
        };
        yield {
          type: "message.delta",
          runId: "run-1",
          messageId: "message-1",
          delta: "Use a centered layout.",
          timestamp: "2026-08-20T00:00:01.000Z",
        };
      })(),
    );
    const createMessage = vi.fn();

    await bindWithCreatedRun(socket, agentRuns, {
      chatService: { createMessage } as never,
    });
    socket.emit("message", runCommand());
    await nextTurn();
    await nextTurn();

    expect(createMessage).toHaveBeenCalledWith(
      user,
      "session-1",
      expect.objectContaining({
        content: "Use a centered layout.",
        contentBlocks: [
          { type: "thinking", thinking: "Consider the composition." },
          { type: "text", text: "Use a centered layout." },
        ],
        role: "assistant",
      }),
    );
    socket.emit("close");
  });

  it("does not fabricate run.failed when finalization is unconfirmed", async () => {
    const socket = new FakeSocket();
    const agentRuns = fakeAgentRuns();
    agentRuns.registerRun.mockReturnValue({
      ownership: "created",
      response: {
        conversationId: "conversation-1",
        runId: "run-1",
        sessionId: "session-1",
        status: "accepted",
      },
    });
    agentRuns.streamRun.mockReturnValue({
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            throw new AgentFinalizationUnconfirmedError("corr-1");
          },
        };
      },
    } as never);
    const connectionManager = new ConnectionManager();
    const pushToCanvas = vi.spyOn(connectionManager, "pushToCanvas");

    await bindAuthenticatedSocket(
      socket as never,
      "token",
      { url: "/api/ws", headers: { host: "localhost" } } as never,
      {
        agentRuns: agentRuns as never,
        authorization: fakeAuthorization("canvas-1"),
        auth: { authenticate: async () => user },
        connectionManager,
        prepareAgentRun: async () => preparedRun(true),
      },
    );
    socket.emit("message", runCommand());
    await nextTurn();
    await nextTurn();

    expect(pushToCanvas).not.toHaveBeenCalledWith(
      "canvas-1",
      expect.objectContaining({ type: "run.failed" }),
    );
    expect(
      socket.messages.map((message) => JSON.parse(message)),
    ).toContainEqual(
      expect.objectContaining({
        action: "agent.run",
        clientRequestId: "request-1",
        runId: "run-1",
        type: "error",
        error: expect.objectContaining({
          code: "run_finalization_unconfirmed",
          correlationId: "corr-1",
        }),
      }),
    );
    expect(connectionManager.getActiveRun("canvas-1")).toMatchObject({
      runId: "run-1",
      sessionId: "session-1",
    });
    socket.emit("close");
  });

  it("does not remove a replacement when the stale socket reports an error", async () => {
    const first = new FakeSocket();
    const replacement = new FakeSocket();
    const connectionManager = new ConnectionManager();
    const options = {
      agentRuns: fakeAgentRuns() as never,
      authorization: fakeAuthorization("canvas-1"),
      auth: { authenticate: async () => user },
      connectionManager,
    };

    await bindAuthenticatedSocket(
      first as never,
      "token",
      {
        url: "/api/ws?connectionId=connection-1",
        headers: { host: "localhost" },
      } as never,
      options,
    );
    await bindAuthenticatedSocket(
      replacement as never,
      "token",
      {
        url: "/api/ws?connectionId=connection-1",
        headers: { host: "localhost" },
      } as never,
      options,
    );

    first.emit("error", new Error("stale socket"));

    expect(connectionManager.getEntry("connection-1")?.ws).toBe(replacement);
    replacement.emit("close");
  });

  it("authorizes canvas resume before replay work begins", async () => {
    let authorizedCanvas: string | undefined;
    const authorization = fakeAuthorization("canvas-1", {
      onCanvas: (canvasId) => {
        authorizedCanvas = canvasId;
      },
    });

    await authorizeCanvasResume(authorization, user, "canvas-1");

    expect(authorizedCanvas).toBe("canvas-1");
  });

  it("authorizes a run before cancellation begins", async () => {
    let authorizedRun: string | undefined;
    const authorization = fakeAuthorization("canvas-1", {
      onRun: (runId) => {
        authorizedRun = runId;
      },
    });

    await authorizeRunCancel(authorization, user, "run-1");

    expect(authorizedRun).toBe("run-1");
  });

  it("does not read another canvas event buffer when resume is forbidden", async () => {
    const socket = new FakeSocket();
    const getAfter = vi.fn();
    const authorization = rejectingAuthorization();

    await bindAuthenticatedSocket(
      socket as never,
      "token",
      { url: "/api/ws", headers: { host: "localhost" } } as never,
      {
        agentRuns: fakeAgentRuns() as never,
        authorization,
        auth: { authenticate: async () => user },
        connectionManager: new ConnectionManager(),
        eventBuffer: { getAfter, getLatestSeq: vi.fn() } as never,
      },
    );

    socket.emit(
      "message",
      JSON.stringify({
        type: "command",
        action: "canvas.resume",
        payload: { canvasId: "other-canvas", lastSeq: 0 },
      }),
    );
    await nextTurn();

    expect(getAfter).not.toHaveBeenCalled();
    expect(
      socket.messages.map((message) => JSON.parse(message)),
    ).toContainEqual(
      expect.objectContaining({
        type: "error",
        error: expect.objectContaining({ code: "forbidden" }),
      }),
    );
    socket.emit("close");
  });

  it("does not cancel another user's run when authorization fails", async () => {
    const socket = new FakeSocket();
    const agentRuns = fakeAgentRuns();

    await bindAuthenticatedSocket(
      socket as never,
      "token",
      { url: "/api/ws", headers: { host: "localhost" } } as never,
      {
        agentRuns: agentRuns as never,
        authorization: rejectingAuthorization(),
        auth: { authenticate: async () => user },
        connectionManager: new ConnectionManager(),
      },
    );

    socket.emit(
      "message",
      JSON.stringify({
        type: "command",
        action: "agent.cancel",
        payload: { runId: "other-run" },
      }),
    );
    await nextTurn();

    expect(agentRuns.cancelRun).not.toHaveBeenCalled();
    expect(
      socket.messages.map((message) => JSON.parse(message)),
    ).toContainEqual(
      expect.objectContaining({
        type: "error",
        error: expect.objectContaining({ code: "forbidden" }),
      }),
    );
    socket.emit("close");
  });

  it("treats agent.cancel as run cancellation and never background job cancellation", async () => {
    const socket = new FakeSocket();
    const agentRuns = fakeAgentRuns();
    agentRuns.cancelRun.mockReturnValue({ runId: "run-1", status: "canceled" });
    const cancelGeneration = vi.fn();

    await bindAuthenticatedSocket(
      socket as never,
      "token",
      { url: "/api/ws", headers: { host: "localhost" } } as never,
      {
        agentRuns: agentRuns as never,
        authorization: fakeAuthorization("canvas-1"),
        auth: { authenticate: async () => user },
        cancelGeneration,
        connectionManager: new ConnectionManager(),
      } as never,
    );

    socket.emit(
      "message",
      JSON.stringify({
        type: "command",
        action: "agent.cancel",
        payload: { runId: "run-1" },
      }),
    );
    await nextTurn();

    expect(agentRuns.cancelRun).toHaveBeenCalledWith("run-1");
    expect(cancelGeneration).not.toHaveBeenCalled();
    socket.emit("close");
  });

  it("does not create a run when its session resources are forbidden", async () => {
    const socket = new FakeSocket();
    const agentRuns = fakeAgentRuns();

    await bindAuthenticatedSocket(
      socket as never,
      "token",
      { url: "/api/ws", headers: { host: "localhost" } } as never,
      {
        agentRuns: agentRuns as never,
        authorization: rejectingAuthorization(),
        auth: { authenticate: async () => user },
        connectionManager: new ConnectionManager(),
        prepareAgentRun: async () => {
          throw new AgentRunError({
            code: "agent_context_forbidden",
            message: "You do not have access to this Agent context.",
            retryable: false,
            statusCode: 403,
          });
        },
      },
    );

    socket.emit(
      "message",
      JSON.stringify({
        type: "command",
        action: "agent.run",
        payload: {
          canvasId: "other-canvas",
          clientRequestId: "request-1",
          conversationId: "other-canvas",
          sessionId: "other-session",
          prompt: "test",
        },
      }),
    );
    await nextTurn();

    expect(agentRuns.registerRun).not.toHaveBeenCalled();
    expect(
      socket.messages.map((message) => JSON.parse(message)),
    ).toContainEqual(
      expect.objectContaining({
        action: "agent.run",
        clientRequestId: "request-1",
        error: expect.objectContaining({ code: "agent_context_forbidden" }),
        retryable: false,
        type: "error",
      }),
    );
    socket.emit("close");
  });
});

function fakeAuthorization(
  canvasId: string,
  hooks: {
    onCanvas?: (canvasId: string) => void;
    onRun?: (runId: string) => void;
  } = {},
): ResourceAuthorization {
  return {
    requireCanvasAccess: async (_user, requestedCanvasId) => {
      hooks.onCanvas?.(requestedCanvasId);
    },
    requireSessionAccess: async () => ({ canvasId }),
    requireRunAccess: async (_user, runId) => {
      hooks.onRun?.(runId);
      return { canvasId };
    },
  };
}

function rejectingAuthorization(): ResourceAuthorization {
  return {
    requireCanvasAccess: async () => {
      throw new ResourceAuthorizationError();
    },
    requireSessionAccess: async () => {
      throw new ResourceAuthorizationError();
    },
    requireRunAccess: async () => {
      throw new ResourceAuthorizationError();
    },
  };
}

function fakeAgentRuns() {
  return {
    cancelRun: vi.fn(),
    createRun: vi.fn(),
    registerRun: vi.fn(),
    isRunRecoverable: vi.fn(),
    getRunRequest: vi.fn(),
    streamRun: vi.fn(),
  };
}

function createdAgentRuns(stream: AsyncIterable<unknown>) {
  const agentRuns = fakeAgentRuns();
  agentRuns.registerRun.mockReturnValue({
    ownership: "created",
    response: {
      conversationId: "conversation-1",
      runId: "run-1",
      sessionId: "session-1",
      status: "accepted",
    },
  });
  agentRuns.streamRun.mockReturnValue(stream);
  return agentRuns;
}

async function bindWithCreatedRun(
  socket: FakeSocket,
  agentRuns: ReturnType<typeof fakeAgentRuns>,
  services: Record<string, unknown>,
) {
  await bindAuthenticatedSocket(
    socket as never,
    "token",
    { url: "/api/ws", headers: { host: "localhost" } } as never,
    {
      agentRuns: agentRuns as never,
      authorization: fakeAuthorization("canvas-1"),
      auth: { authenticate: async () => user },
      connectionManager: new ConnectionManager(),
      prepareAgentRun: async () => preparedRun(true),
      ...services,
    } as never,
  );
}

function runCommand() {
  return JSON.stringify({
    type: "command",
    action: "agent.run",
    payload: {
      canvasId: "canvas-1",
      clientRequestId: "request-1",
      conversationId: "conversation-1",
      sessionId: "session-1",
      prompt: "test",
    },
  });
}

function preparedRun(created: boolean) {
  return {
    accepted: {
      created,
      requestDigest: "digest-1",
      runId: "run-1",
      status: "accepted" as const,
    },
    context: {
      accessToken: "token",
      canvasId: "canvas-1",
      conversationId: "conversation-1",
      projectId: "project-1",
      sessionId: "session-1",
      threadId: "thread-1",
      userId: "user-1",
      workspaceId: "workspace-1",
    },
    model: "openai:test",
  };
}

class FakeSocket extends EventEmitter {
  readyState = 1;
  messages: string[] = [];

  send(message: string) {
    this.messages.push(message);
  }

  close() {
    this.readyState = 3;
  }

  ping() {}

  terminate() {
    this.readyState = 3;
  }
}

async function nextTurn() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForTurns(turns: number) {
  for (let turn = 0; turn < turns; turn += 1) await nextTurn();
}
