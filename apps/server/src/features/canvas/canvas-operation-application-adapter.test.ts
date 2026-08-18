import { describe, expect, it, vi } from "vitest";

import {
  createCanvasAuthorizationPort,
  createCanvasServiceOperationPort,
} from "./canvas-operation-application-adapter.js";

describe("canvas operation application adapter", () => {
  it("delegates authorization to the existing resource boundary", async () => {
    const requireCanvasAccess = vi.fn(async () => undefined);
    const user = { id: "user-1", accessToken: "token", userMetadata: {} };
    const adapter = createCanvasAuthorizationPort({
      authorization: { requireCanvasAccess } as never,
      toAuthenticatedUser: () => user as never,
    });

    await adapter.requireCanvasAccess(
      { userId: "user-1", workspaceId: "workspace-1" },
      "canvas-1",
    );

    expect(requireCanvasAccess).toHaveBeenCalledWith(user, "canvas-1");
  });

  it("loads, applies current move/add/delete operations, and saves through CanvasService", async () => {
    const content = {
      elements: [
        {
          id: "move-me",
          type: "rectangle",
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          version: 1,
          versionNonce: 1,
        },
        {
          id: "delete-me",
          type: "rectangle",
          x: 200,
          y: 0,
          width: 100,
          height: 100,
          version: 1,
          versionNonce: 1,
        },
      ],
      appState: {},
      files: {},
    };
    const original = structuredClone(content);
    const canvasService = {
      getCanvas: vi.fn(async () => ({
        id: "canvas-1",
        name: "Canvas",
        projectId: "project-1",
        revision: 3,
        content,
      })),
      saveCanvasContent: vi.fn(
        async (
          _user: unknown,
          _canvasId: string,
          _revision: number,
          _content: typeof content,
        ) => ({ revision: 4 }),
      ),
    };
    const user = { id: "user-1", accessToken: "token", userMetadata: {} };
    const adapter = createCanvasServiceOperationPort({
      canvasService,
      toAuthenticatedUser: () => user as never,
    });

    await expect(
      adapter.apply({
        principal: { userId: "user-1", workspaceId: "workspace-1" },
        canvasId: "canvas-1",
        operations: [
          { action: "move", element_id: "move-me", x: 40, y: 60 },
          { action: "add_text", text: "New note", x: 10, y: 20 },
          { action: "delete", element_id: "delete-me" },
        ],
      }),
    ).resolves.toMatchObject({ canvasId: "canvas-1", applied: 3 });

    const saved = vi.mocked(canvasService.saveCanvasContent).mock.calls[0]?.[3];
    expect(saved?.elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "move-me", x: 40, y: 60 }),
        expect.objectContaining({ id: "delete-me", isDeleted: true }),
        expect.objectContaining({ type: "text", text: "New note" }),
      ]),
    );
    expect(content).toEqual(original);
  });

  it.each([
    ["all skipped", [{ action: "delete", element_id: "missing" }]],
    [
      "mixed applied and skipped",
      [
        { action: "move", element_id: "move-me", x: 10, y: 20 },
        { action: "delete", element_id: "missing" },
      ],
    ],
  ])("does not save an atomic batch when %s", async (_label, operations) => {
    const content = {
      elements: [
        {
          id: "move-me",
          type: "rectangle",
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          version: 1,
          versionNonce: 1,
        },
      ],
      appState: {},
      files: {},
    };
    const before = structuredClone(content);
    const canvasService = {
      getCanvas: vi.fn(async () => ({
        id: "canvas-1",
        name: "Canvas",
        projectId: "project-1",
        revision: 3,
        content,
      })),
      saveCanvasContent: vi.fn(async () => ({ revision: 4 })),
    };
    const adapter = createCanvasServiceOperationPort({
      canvasService,
      toAuthenticatedUser: () => ({ id: "user-1" }) as never,
    });

    await expect(
      adapter.apply({
        principal: { userId: "user-1", workspaceId: "workspace-1" },
        canvasId: "canvas-1",
        operations: operations as never,
      }),
    ).rejects.toMatchObject({ code: "invalid_request", statusCode: 400 });
    expect(canvasService.saveCanvasContent).not.toHaveBeenCalled();
    expect(content).toEqual(before);
  });

  it("does not mutate loaded content when saving fails", async () => {
    const content = {
      elements: [
        {
          id: "element-1",
          type: "rectangle",
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          version: 1,
          versionNonce: 1,
        },
      ],
      appState: {},
      files: {},
    };
    const before = structuredClone(content);
    const adapter = createCanvasServiceOperationPort({
      canvasService: {
        getCanvas: async () => ({
          id: "canvas-1",
          name: "Canvas",
          projectId: "project-1",
          revision: 3,
          content,
        }),
        saveCanvasContent: async () => {
          throw new Error("save failed");
        },
      },
      toAuthenticatedUser: () => ({ id: "user-1" }) as never,
    });

    await expect(
      adapter.apply({
        principal: { userId: "user-1", workspaceId: "workspace-1" },
        canvasId: "canvas-1",
        operations: [{ action: "move", element_id: "element-1", x: 10, y: 20 }],
      }),
    ).rejects.toThrow("save failed");
    expect(content).toEqual(before);
  });

  it("re-reads and reapplies replay-safe operations after a revision conflict", async () => {
    const getCanvas = vi
      .fn()
      .mockResolvedValueOnce({
        id: "canvas-1",
        name: "Canvas",
        projectId: "project-1",
        revision: 2,
        content: { elements: [], appState: {}, files: {} },
      })
      .mockResolvedValueOnce({
        id: "canvas-1",
        name: "Canvas",
        projectId: "project-1",
        revision: 3,
        content: { elements: [], appState: {}, files: {} },
      });
    const saveCanvasContent = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("conflict"), {
          code: "canvas_revision_conflict",
        }),
      )
      .mockResolvedValueOnce({ revision: 4 });
    const adapter = createCanvasServiceOperationPort({
      canvasService: { getCanvas, saveCanvasContent },
      toAuthenticatedUser: () => ({ id: "user-1" }) as never,
    });

    await adapter.apply({
      principal: { userId: "user-1", workspaceId: "workspace-1" },
      canvasId: "canvas-1",
      operations: [{ action: "add_text", text: "retry", x: 1, y: 2 }],
    });

    expect(getCanvas).toHaveBeenCalledTimes(2);
    expect(saveCanvasContent).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      "canvas-1",
      3,
      expect.objectContaining({
        elements: [expect.objectContaining({ text: "retry" })],
      }),
    );
  });

  it("returns the recorded result when an Agent canvas effect is replayed", async () => {
    const recorded = {
      canvasId: "canvas-1",
      applied: 1,
      descriptions: ["recorded"],
      createdIds: { element: "committed-id" },
      errors: [],
    };
    const adapter = createCanvasServiceOperationPort({
      canvasService: {
        getCanvas: async () => ({
          id: "canvas-1",
          name: "Canvas",
          projectId: "project-1",
          revision: 4,
          content: { elements: [], appState: {}, files: {} },
        }),
        saveCanvasContent: async () => ({
          revision: 4,
          replayed: true,
          effectResult: recorded,
        }),
      },
      toAuthenticatedUser: () => ({ id: "user-1" }) as never,
    });
    await expect(
      adapter.apply({
        principal: { userId: "user-1", workspaceId: "workspace-1" },
        canvasId: "canvas-1",
        operations: [{ action: "add_text", text: "retry", x: 1, y: 2 }],
        agentEffect: {
          runId: "run-1",
          attemptId: "attempt-1",
          fencingToken: 1,
          logicalToolCallId: "tool-1",
          inputDigest: "digest-1",
        },
      }),
    ).resolves.toEqual(recorded);
  });

  it("persists only the bounded public outcome for an Agent canvas effect", async () => {
    const saveCanvasContent = vi.fn(async (..._args: unknown[]) => ({
      revision: 2,
    }));
    const adapter = createCanvasServiceOperationPort({
      canvasService: {
        getCanvas: async () => ({
          id: "canvas-1",
          name: "Canvas",
          projectId: "project-1",
          revision: 1,
          content: { elements: [], appState: {}, files: {} },
        }),
        saveCanvasContent,
      },
      toAuthenticatedUser: () => ({ id: "user-1" }) as never,
    });

    const result = await adapter.apply({
      principal: { userId: "user-1", workspaceId: "workspace-1" },
      canvasId: "canvas-1",
      operations: [{ action: "add_text", text: "bounded", x: 1, y: 2 }],
      agentEffect: {
        runId: "run-1",
        attemptId: "attempt-1",
        fencingToken: 1,
        logicalToolCallId: "tool-1",
        inputDigest: "digest-1",
      },
    });

    const persistedEffect = saveCanvasContent.mock.calls[0]?.[4] as
      | { result?: unknown }
      | undefined;
    expect(persistedEffect?.result).toEqual(result);
    expect(persistedEffect?.result).not.toHaveProperty("content");
  });
});
