import { describe, expect, it } from "vitest";

import {
  panelAnchor,
  rotatedScreenBounds,
  sceneRectToScreen,
} from "../src/lib/canvas-overlay-geometry";

describe("canvas overlay geometry", () => {
  const sceneRect = {
    x: 20,
    y: 30,
    width: 100,
    height: 50,
    angle: Math.PI / 2,
  };
  const transform = {
    scrollX: 10,
    scrollY: -5,
    zoom: 2,
    offsetLeft: 400,
    offsetTop: 12,
  };

  it("converts scene geometry with the current canvas transform", () => {
    expect(sceneRectToScreen(sceneRect, transform)).toEqual({
      left: 460,
      top: 62,
      width: 200,
      height: 100,
    });
  });

  it("keeps the center while calculating rotated screen bounds", () => {
    const bounds = rotatedScreenBounds(
      sceneRectToScreen(sceneRect, transform),
      sceneRect.angle,
    );

    expect(bounds.left).toBeCloseTo(510);
    expect(bounds.top).toBeCloseTo(12);
    expect(bounds.width).toBeCloseTo(100);
    expect(bounds.height).toBeCloseTo(200);
  });

  it("anchors the panel below the rotated bounding box", () => {
    expect(panelAnchor(sceneRect, transform, 8)).toEqual({
      left: 510,
      top: 220,
    });
  });
});
