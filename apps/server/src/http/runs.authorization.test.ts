import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { ResourceAuthorizationError } from "../security/resource-authorization.js";
import { registerErrorHandler } from "./error-handler.js";
import { registerRunRoutes } from "./runs.js";

describe("HTTP run authorization", () => {
  it("does not create a run when the requested canvas differs from the session", async () => {
    const app = Fastify();
    registerErrorHandler(app);
    const agentRuns = fakeAgentRuns();
    await registerRunRoutes(app, agentRuns as never, {
      auth: { authenticate: async () => authenticatedUser },
      authorization: {
        requireCanvasAccess: vi.fn(),
        requireSessionAccess: async () => ({ canvasId: "canvas-1" }),
        requireRunAccess: vi.fn(),
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/agent/runs",
      payload: {
        sessionId: "session-1",
        conversationId: "other-canvas",
        canvasId: "other-canvas",
        clientRequestId: "request-1",
        prompt: "test",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: { code: "forbidden" },
    });
    expect(agentRuns.createRun).not.toHaveBeenCalled();
    await app.close();
  });

  it("does not cancel a run when object authorization fails", async () => {
    const app = Fastify();
    registerErrorHandler(app);
    const agentRuns = fakeAgentRuns();
    await registerRunRoutes(app, agentRuns as never, {
      auth: { authenticate: async () => authenticatedUser },
      authorization: {
        requireCanvasAccess: vi.fn(),
        requireSessionAccess: vi.fn(),
        requireRunAccess: async () => {
          throw new ResourceAuthorizationError();
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/agent/runs/other-run/cancel",
    });

    expect(response.statusCode).toBe(403);
    expect(agentRuns.cancelRun).not.toHaveBeenCalled();
    await app.close();
  });
});

const authenticatedUser = {
  accessToken: "token",
  email: "designer@example.com",
  id: "user-1",
  userMetadata: {},
};

function fakeAgentRuns() {
  return {
    cancelRun: vi.fn(),
    createRun: vi.fn(() => ({
      conversationId: "other-canvas",
      runId: "run-1",
      sessionId: "session-1",
      status: "accepted",
    })),
    streamRun: vi.fn(),
  };
}
