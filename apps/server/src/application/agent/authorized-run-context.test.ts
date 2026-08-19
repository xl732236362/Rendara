import { describe, expect, it, vi } from "vitest";

import { createAuthorizedRunContextResolver } from "./authorized-run-context.js";

const principal = {
  accessToken: "current-token",
  userId: "user-1",
};

const request = {
  canvasId: "canvas-1",
  conversationId: "conversation-independent",
  sessionId: "session-1",
};

const scope = {
  canvasId: "canvas-1",
  projectId: "project-1",
  sessionId: "session-1",
  threadId: "thread-1",
  workspaceId: "workspace-1",
};

describe("authorized Agent run context", () => {
  it("resolves one canonical session scope and preserves conversation identity", async () => {
    const resolveSessionScope = vi.fn(async () => scope);
    const resolve = createAuthorizedRunContextResolver({ resolveSessionScope });

    const context = await resolve(principal, request);

    expect(context).toEqual({
      ...scope,
      ...principal,
      conversationId: "conversation-independent",
    });
    expect(Object.isFrozen(context)).toBe(true);
    expect(resolveSessionScope).toHaveBeenCalledOnce();
    expect(resolveSessionScope).toHaveBeenCalledWith(
      principal,
      "session-1",
      undefined,
    );
  });

  it("passes cancellation to the single scope query", async () => {
    const resolveSessionScope = vi.fn(async () => scope);
    const resolve = createAuthorizedRunContextResolver({ resolveSessionScope });
    const controller = new AbortController();

    await resolve(principal, request, controller.signal);

    expect(resolveSessionScope).toHaveBeenCalledWith(
      principal,
      "session-1",
      controller.signal,
    );
  });

  it("rejects a request canvas outside the session scope", async () => {
    const resolve = createAuthorizedRunContextResolver({
      resolveSessionScope: async () => scope,
    });

    await expect(
      resolve(principal, { ...request, canvasId: "canvas-other" }),
    ).rejects.toMatchObject({
      code: "agent_context_forbidden",
      retryable: false,
      statusCode: 403,
    });
  });

  it("rejects a missing session without disclosing its existence", async () => {
    const resolve = createAuthorizedRunContextResolver({
      resolveSessionScope: async () => null,
    });

    await expect(resolve(principal, request)).rejects.toMatchObject({
      code: "agent_context_forbidden",
      retryable: false,
      statusCode: 403,
    });
  });

  it("keeps a scope dependency outage retryable and distinct from denial", async () => {
    const resolve = createAuthorizedRunContextResolver({
      resolveSessionScope: async () => {
        throw new Error("database connection failed with sensitive detail");
      },
    });

    await expect(resolve(principal, request)).rejects.toMatchObject({
      code: "agent_context_unavailable",
      message: "Agent context is temporarily unavailable.",
      retryable: true,
      statusCode: 503,
    });
  });
});
