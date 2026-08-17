import { describe, expect, it } from "vitest";

import {
  CanvasOperationError,
  applyCanvasOperations,
  parseCanvasOperations,
} from "./canvas-operation-engine.js";

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
      boundElements: [{ id: "label-1", type: "text" }],
    },
    {
      id: "label-1",
      type: "text",
      x: 10,
      y: 10,
      width: 20,
      height: 20,
      version: 1,
      versionNonce: 1,
    },
  ],
  appState: { selectedElementIds: { "element-1": true } },
  files: {},
};

describe("canvas operation engine contract", () => {
  it("strictly requires action fields and rejects unrelated fields", () => {
    expect(() =>
      parseCanvasOperations([{ action: "move", element_id: "element-1" }]),
    ).toThrow(CanvasOperationError);
    expect(() =>
      parseCanvasOperations([
        {
          action: "delete",
          element_id: "element-1",
          text: "not allowed",
        },
      ]),
    ).toThrow(CanvasOperationError);
  });

  it("never mutates input content or nested element data", () => {
    const input = structuredClone(content);
    const before = structuredClone(input);

    const outcome = applyCanvasOperations(input, [
      { action: "delete", element_id: "element-1" },
    ]);

    expect(input).toEqual(before);
    expect(outcome.content).not.toBe(input);
    expect(outcome.content.elements[0]).not.toBe(input.elements[0]);
  });
});
