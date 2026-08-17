import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

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
      expect.objectContaining({ type: "error", code: "forbidden" }),
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
      expect.objectContaining({ type: "error", code: "forbidden" }),
    );
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
      },
    );

    socket.emit(
      "message",
      JSON.stringify({
        type: "command",
        action: "agent.run",
        payload: {
          canvasId: "other-canvas",
          conversationId: "other-canvas",
          sessionId: "other-session",
          prompt: "test",
        },
      }),
    );
    await nextTurn();

    expect(agentRuns.createRun).not.toHaveBeenCalled();
    expect(
      socket.messages.map((message) => JSON.parse(message)),
    ).toContainEqual(
      expect.objectContaining({ type: "error", code: "forbidden" }),
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
    streamRun: vi.fn(),
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
