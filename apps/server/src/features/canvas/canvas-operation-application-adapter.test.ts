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
    const canvasService = {
      getCanvas: vi.fn(async () => ({
        id: "canvas-1",
        name: "Canvas",
        projectId: "project-1",
        content,
      })),
      saveCanvasContent: vi.fn(
        async (_user: unknown, _canvasId: string, _content: typeof content) =>
          undefined,
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
    ).resolves.toEqual({ canvasId: "canvas-1", applied: 3 });

    const saved = vi.mocked(canvasService.saveCanvasContent).mock.calls[0]?.[2];
    expect(saved?.elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "move-me", x: 40, y: 60 }),
        expect.objectContaining({ id: "delete-me", isDeleted: true }),
        expect.objectContaining({ type: "text", text: "New note" }),
      ]),
    );
  });
});
