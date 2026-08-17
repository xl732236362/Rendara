export type SceneRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  angle?: number;
};

export type CanvasTransform = {
  scrollX: number;
  scrollY: number;
  zoom: number;
  offsetLeft?: number;
  offsetTop?: number;
};

export type ScreenRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export function sceneRectToScreen(
  rect: SceneRect,
  transform: CanvasTransform,
): ScreenRect {
  const { scrollX, scrollY, zoom, offsetLeft = 0, offsetTop = 0 } = transform;
  return {
    left: (rect.x + scrollX) * zoom + offsetLeft,
    top: (rect.y + scrollY) * zoom + offsetTop,
    width: rect.width * zoom,
    height: rect.height * zoom,
  };
}

export function rotatedScreenBounds(
  rect: ScreenRect,
  angle: number,
): ScreenRect {
  const cos = Math.abs(Math.cos(angle));
  const sin = Math.abs(Math.sin(angle));
  const width = rect.width * cos + rect.height * sin;
  const height = rect.width * sin + rect.height * cos;
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;

  return {
    left: centerX - width / 2,
    top: centerY - height / 2,
    width,
    height,
  };
}

export function panelAnchor(
  rect: SceneRect,
  transform: CanvasTransform,
  gap = 8,
): { left: number; top: number } {
  const bounds = rotatedScreenBounds(
    sceneRectToScreen(rect, transform),
    rect.angle ?? 0,
  );
  return { left: bounds.left, top: bounds.top + bounds.height + gap };
}
