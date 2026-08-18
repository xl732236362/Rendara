import { describe, expect, it } from "vitest";
import {
  CanvasNodeRegistry,
  applyCanvasPatch,
  assetManifestSchema,
  defaultCanvasNodeRegistry,
} from "./canvas-domain.js";

const node = (id: string, type = "text") => ({
  id,
  type,
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  version: 1,
  isDeleted: false,
});

describe("canvas domain model", () => {
  it("uses a sealed single registry and rejects unknown nodes", () => {
    expect(defaultCanvasNodeRegistry.list()).toHaveLength(9);
    expect(() =>
      defaultCanvasNodeRegistry.validate(node("x", "plugin")),
    ).toThrow("Invalid option");
    expect(() =>
      defaultCanvasNodeRegistry.register({
        type: "text",
        version: 1,
        validate: () => node("x"),
      }),
    ).toThrow("sealed");
  });

  it("applies versioned add/replace/remove patches atomically", () => {
    const result = applyCanvasPatch([node("a")], {
      baseRevision: 4,
      operations: [
        {
          op: "replace",
          nodeId: "a",
          node: { ...node("ignored"), x: 20, version: 2 },
        },
        { op: "add", node: node("b", "rectangle") },
        { op: "remove", nodeId: "a" },
      ],
    });
    expect(result).toEqual({ nodes: [node("b", "rectangle")], revision: 5 });
  });

  it("rejects duplicate assets and traversal paths", () => {
    expect(() =>
      assetManifestSchema.parse({
        version: 1,
        assets: [
          {
            assetId: "a",
            mimeType: "image/png",
            byteSize: 1,
            sha256: "a".repeat(64),
            objectPath: "../secret",
          },
        ],
      }),
    ).toThrow();
  });
});
