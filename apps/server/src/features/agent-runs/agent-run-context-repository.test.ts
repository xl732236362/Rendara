import { describe, expect, it, vi } from "vitest";

import { createAgentSessionScopeResolver } from "./agent-run-context-repository.js";

const principal = { accessToken: "user-token", userId: "user-1" };

function setup(result: { data: unknown; error: unknown }) {
  const maybeSingle = vi.fn(async () => result);
  const query = {
    abortSignal: vi.fn(),
    eq: vi.fn(),
    maybeSingle,
    select: vi.fn(),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.abortSignal.mockReturnValue(query);
  const from = vi.fn(() => query);
  const createUserClient = vi.fn(() => ({ from }));

  return {
    createUserClient,
    from,
    maybeSingle,
    query,
    resolve: createAgentSessionScopeResolver({
      createUserClient: createUserClient as never,
    }),
  };
}

describe("Agent run context repository", () => {
  it("resolves the complete session scope with one user-scoped query", async () => {
    const subject = setup({
      data: {
        id: "session-1",
        thread_id: "thread-1",
        canvas_id: "canvas-1",
        canvases: {
          id: "canvas-1",
          project_id: "project-1",
          projects: { workspace_id: "workspace-1" },
        },
      },
      error: null,
    });

    await expect(subject.resolve(principal, "session-1")).resolves.toEqual({
      canvasId: "canvas-1",
      projectId: "project-1",
      sessionId: "session-1",
      threadId: "thread-1",
      workspaceId: "workspace-1",
    });
    expect(subject.createUserClient).toHaveBeenCalledWith("user-token");
    expect(subject.from).toHaveBeenCalledOnce();
    expect(subject.from).toHaveBeenCalledWith("chat_sessions");
    expect(subject.query.select).toHaveBeenCalledWith(
      "id, thread_id, canvas_id, canvases!inner(id, project_id, projects!inner(workspace_id))",
    );
    expect(subject.query.eq).toHaveBeenCalledWith("id", "session-1");
    expect(subject.maybeSingle).toHaveBeenCalledOnce();
  });

  it("passes an AbortSignal to PostgREST when supplied", async () => {
    const subject = setup({ data: null, error: null });
    const controller = new AbortController();

    await subject.resolve(principal, "session-1", controller.signal);

    expect(subject.query.abortSignal).toHaveBeenCalledWith(controller.signal);
  });

  it("returns null for missing or malformed authorized relationships", async () => {
    const missing = setup({ data: null, error: null });
    const malformed = setup({
      data: {
        id: "session-1",
        thread_id: null,
        canvas_id: "canvas-1",
        canvases: null,
      },
      error: null,
    });

    await expect(missing.resolve(principal, "session-1")).resolves.toBeNull();
    await expect(malformed.resolve(principal, "session-1")).resolves.toBeNull();
  });

  it("does not expose PostgREST details when the scope query fails", async () => {
    const subject = setup({
      data: null,
      error: { message: "sentinel database detail" },
    });

    await expect(subject.resolve(principal, "session-1")).rejects.toThrow(
      "agent_context_query_failed",
    );
    await expect(subject.resolve(principal, "session-1")).rejects.not.toThrow(
      "sentinel database detail",
    );
  });
});
