import { describe, expect, it, vi } from "vitest";
import { createManipulateCanvasTool } from "./manipulate-canvas.js";

describe("manipulate_canvas application boundary", () => {
  it("delegates normalized operations and preserves stable output", async () => {
    const applyCanvasOperations = vi.fn(async () => ({
      canvasId: "canvas-1",
      applied: 1,
      descriptions: ["Moved element-1"],
      createdIds: {},
      errors: [],
    }));
    const tool = createManipulateCanvasTool({
      applyCanvasOperations: applyCanvasOperations as never,
      resolveWorkspaceId: async () => "workspace-1",
    });
    const operations = [
      { action: "move" as const, element_id: "element-1", x: 25, y: 35 },
    ];
    const raw = await tool.invoke(
      { operations },
      { configurable: { access_token: "token", canvas_id: "canvas-1" } },
    );
    expect(applyCanvasOperations).toHaveBeenCalledWith(
      { userId: "agent", workspaceId: "workspace-1", accessToken: "token" },
      { canvasId: "canvas-1", operations },
    );
    expect(JSON.parse(raw)).toEqual({
      success: true,
      applied: 1,
      summary: "Moved element-1",
    });
  });

  it("does not invoke the use case without canvas context", async () => {
    const applyCanvasOperations = vi.fn();
    const tool = createManipulateCanvasTool({
      applyCanvasOperations: applyCanvasOperations as never,
      resolveWorkspaceId: async () => "workspace-1",
    });
    const raw = await tool.invoke(
      { operations: [{ action: "delete", element_id: "missing" }] },
      { configurable: { access_token: "token" } },
    );
    expect(applyCanvasOperations).not.toHaveBeenCalled();
    expect(JSON.parse(raw)).toMatchObject({ error: "no_canvas_context" });
  });
});
