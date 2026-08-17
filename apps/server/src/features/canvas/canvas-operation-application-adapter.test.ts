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

  it("delegates loading and saving to CanvasService", async () => {
    const content = { elements: [], appState: {}, files: {} };
    const updated = {
      elements: [{ id: "element-1" }],
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
      saveCanvasContent: vi.fn(async () => undefined),
    };
    const applyOperations = vi.fn(() => ({ content: updated, applied: 1 }));
    const user = { id: "user-1", accessToken: "token", userMetadata: {} };
    const adapter = createCanvasServiceOperationPort({
      canvasService,
      applyOperations,
      toAuthenticatedUser: () => user as never,
    });

    await expect(
      adapter.apply({
        principal: { userId: "user-1", workspaceId: "workspace-1" },
        canvasId: "canvas-1",
        operations: [{ action: "delete", element_id: "element-1" }],
      }),
    ).resolves.toEqual({ canvasId: "canvas-1", applied: 1 });

    expect(applyOperations).toHaveBeenCalledWith(content, [
      { action: "delete", element_id: "element-1" },
    ]);
    expect(canvasService.saveCanvasContent).toHaveBeenCalledWith(
      user,
      "canvas-1",
      updated,
    );
  });
});
