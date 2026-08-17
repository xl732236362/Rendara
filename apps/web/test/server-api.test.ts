// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ApiApplicationError,
  createProject,
  createRun,
  fetchProjects,
  fetchViewer,
  saveCanvas,
} from "../src/lib/server-api";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

function requestHeaders() {
  return new Headers(mockFetch.mock.calls.at(-1)?.[1]?.headers);
}

describe("authenticated server API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_SERVER_BASE_URL", "http://localhost:3001");
  });

  it("fetchViewer sends bearer token and returns viewer response", async () => {
    const viewer = {
      profile: {
        id: "u1",
        email: "a@b.com",
        displayName: "A",
        avatarUrl: null,
      },
      workspace: { id: "w1", name: "W", type: "personal", ownerUserId: "u1" },
      membership: { workspaceId: "w1", userId: "u1", role: "owner" },
    };
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => viewer,
    });

    const result = await fetchViewer("token_abc");
    expect(mockFetch.mock.calls[0]?.[0]).toBe(
      "http://localhost:3001/api/viewer",
    );
    expect(requestHeaders().get("authorization")).toBe("Bearer token_abc");
    expect(result.profile.id).toBe("u1");
  });

  it("createRun sends bearer auth when access token is provided", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({
        runId: "run_123",
        sessionId: "session_123",
        conversationId: "conversation_123",
        status: "accepted",
      }),
    });

    await createRun(
      {
        sessionId: "session_123",
        conversationId: "conversation_123",
        prompt: "Hello",
      },
      { accessToken: "token_abc" },
    );

    expect(mockFetch.mock.calls[0]?.[0]).toBe(
      "http://localhost:3001/api/agent/runs",
    );
    expect(mockFetch.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ method: "POST" }),
    );
    expect(requestHeaders().get("authorization")).toBe("Bearer token_abc");
    expect(requestHeaders().get("content-type")).toBe("application/json");
  });

  it("createRun keeps demo calls unauthenticated by default", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({
        runId: "run_123",
        sessionId: "session_123",
        conversationId: "conversation_123",
        status: "accepted",
      }),
    });

    await createRun({
      sessionId: "session_123",
      conversationId: "conversation_123",
      prompt: "Hello",
    });

    expect(mockFetch.mock.calls[0]?.[0]).toBe(
      "http://localhost:3001/api/agent/runs",
    );
    expect(requestHeaders().has("authorization")).toBe(false);
    expect(requestHeaders().get("content-type")).toBe("application/json");
  });

  it("createProject sends POST with bearer token and handles 201", async () => {
    const project = {
      project: {
        id: "p1",
        name: "Test",
        slug: "test",
        description: null,
        workspace: { id: "w1", name: "W", type: "personal", ownerUserId: "u1" },
        primaryCanvas: { id: "c1", name: "Main Canvas", isPrimary: true },
        createdAt: "2026-03-23T00:00:00Z",
        updatedAt: "2026-03-23T00:00:00Z",
      },
    };
    mockFetch.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => project,
    });

    const result = await createProject("token_abc", { name: "Test" });
    expect(mockFetch.mock.calls[0]?.[0]).toBe(
      "http://localhost:3001/api/projects",
    );
    expect(mockFetch.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ method: "POST" }),
    );
    expect(requestHeaders().get("authorization")).toBe("Bearer token_abc");
    expect(requestHeaders().get("content-type")).toBe("application/json");
    expect(result.project.id).toBe("p1");
  });

  it("fetchProjects sends bearer token and returns list", async () => {
    const list = {
      projects: [
        {
          id: "p1",
          name: "Test",
          slug: "test",
          description: null,
          workspace: {
            id: "w1",
            name: "Workspace",
            type: "personal",
            ownerUserId: "u1",
          },
          primaryCanvas: { id: "c1", name: "Main Canvas", isPrimary: true },
          createdAt: "2026-03-23T00:00:00Z",
          updatedAt: "2026-03-23T00:00:00Z",
        },
      ],
    };
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => list,
    });

    const result = await fetchProjects("token_abc");
    expect(mockFetch.mock.calls[0]?.[0]).toBe(
      "http://localhost:3001/api/projects",
    );
    expect(requestHeaders().get("authorization")).toBe("Bearer token_abc");
    expect(result.projects).toHaveLength(1);
  });

  it("saveCanvas sends the expected revision and parses the committed revision", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, revision: 4 }),
    });
    const content = { elements: [], appState: {}, files: {} };

    await expect(
      saveCanvas("token_abc", "canvas-1", 3, content),
    ).resolves.toEqual({
      ok: true,
      revision: 4,
    });
    expect(JSON.parse(mockFetch.mock.calls[0]?.[1]?.body as string)).toEqual({
      expectedRevision: 3,
      content,
    });
  });

  it("createProject throws ApiApplicationError with code on 409", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        error: { code: "project_slug_taken", message: "Slug taken." },
      }),
    });

    await expect(createProject("token_abc", { name: "Dup" })).rejects.toThrow(
      "Slug taken.",
    );
    try {
      await createProject("token_abc", { name: "Dup" });
    } catch (err) {
      expect(err).toBeInstanceOf(ApiApplicationError);
      if (err instanceof ApiApplicationError) {
        expect(err.code).toBe("project_slug_taken");
      }
    }
  });

  it("fetchViewer throws ApiAuthError on 401", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({
        error: { code: "unauthorized", message: "Bad token." },
      }),
    });

    await expect(fetchViewer("expired")).rejects.toThrow("unauthorized");
  });

  it("fetchProjects throws ApiAuthError on 401", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({
        error: { code: "unauthorized", message: "Bad token." },
      }),
    });

    await expect(fetchProjects("expired")).rejects.toThrow("unauthorized");
  });
});
