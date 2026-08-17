import { describe, expect, it } from "vitest";

import { applyCanvasOperations } from "../../features/canvas/canvas-operation-engine.js";
import { createManipulateCanvasTool } from "./manipulate-canvas.js";

describe("manipulate_canvas operation engine parity", () => {
  it("uses the shared engine behavior for current operations", async () => {
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
    let saved: unknown;
    const client = {
      from: () => ({
        select: () => ({
          eq: () => ({
            single: async () => ({ data: { content }, error: null }),
          }),
        }),
        update: (value: { content: unknown }) => {
          saved = value.content;
          return { eq: async () => ({ error: null }) };
        },
      }),
    };
    const operations = [
      { action: "move" as const, element_id: "element-1", x: 25, y: 35 },
    ];
    const expected = applyCanvasOperations(
      structuredClone(content),
      operations,
    );
    const canvasTool = createManipulateCanvasTool({
      createUserClient: () => client,
    });

    const rawResult = await canvasTool.invoke(
      { operations },
      { configurable: { access_token: "token", canvas_id: "canvas-1" } },
    );

    expect(saved).toMatchObject({
      elements: [
        expect.objectContaining({
          id: "element-1",
          x: expected.content.elements[0]?.x,
          y: expected.content.elements[0]?.y,
          version: expected.content.elements[0]?.version,
        }),
      ],
    });
    expect(JSON.parse(rawResult)).toMatchObject({
      applied: expected.applied,
      summary: expected.descriptions.join("; "),
    });
  });
});
