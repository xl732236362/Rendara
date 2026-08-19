import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { AgentRunError } from "../application/agent/agent-run-errors.js";
import {
  type ResourceAuthorization,
  ResourceAuthorizationError,
} from "../security/resource-authorization.js";
import type { AuthenticatedUser } from "../supabase/user.js";
import { ConnectionManager } from "./connection-manager.js";
import {
  authorizeCanvasResume,
  authorizeRunCancel,
  authorizeRunResources,
  bindAuthenticatedSocket,
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

    expect(setActiveRun.mock.invocationCallOrder[0]).toBeLessThan(
      sendTo.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(agentRuns.streamRun).toHaveBeenCalledOnce();
    socket.emit("close");
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
    streamRun: vi.fn(),
  };
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
