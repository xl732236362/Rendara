import { describe, expect, it, vi } from "vitest";
import { createAttachGeneratedAsset } from "./attach-generated-asset.js";

describe("AttachGeneratedAsset", () => {
  it("authorizes then delegates a validated generated image", async () => {
    const calls: string[] = [];
    const attach = vi.fn(async (_command: unknown) => ({
      elementId: "element-1",
    }));
    const useCase = createAttachGeneratedAsset({
      authorization: {
        requireCanvasAccess: async () => {
          calls.push("authorize");
        },
      },
      assets: {
        attach: async (command) => {
          calls.push("attach");
          return attach(command);
        },
      },
    });
    const command = {
      canvasId: "canvas-1",
      jobId: "11111111-1111-4111-8111-111111111111",
      effectKey: "generated_asset_attached",
      asset: {
        type: "image" as const,
        objectPath: "generated/a.png",
        width: 100,
        height: 80,
        mimeType: "image/png",
        title: "A",
      },
    };
    await expect(
      useCase(
        { userId: "user-1", workspaceId: "workspace-1", accessToken: "token" },
        command,
      ),
    ).resolves.toEqual({ elementId: "element-1" });
    expect(calls).toEqual(["authorize", "attach"]);
  });
});
