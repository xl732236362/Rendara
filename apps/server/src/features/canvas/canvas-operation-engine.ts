import { type CanvasContent, defaultCanvasNodeRegistry } from "@loomic/shared";
import { z } from "zod";
import {
  BINDING_GAP,
  type CanvasElement,
  type HandlerResult,
  bumpVersion,
  coerceColor,
  computeEdgePoint,
  computeFixedPoint,
  createElementBase,
  ensureBoundElements,
  findElement,
  generateId,
  getElementCenter,
  measureTextWidth,
  shortLabel,
  validateBindings,
} from "./canvas-element-helpers.js";

// Re-export for consumers that import measureTextWidth from this module
// (e.g. the test suite). New code should import directly from canvas-element-helpers.
export { measureTextWidth } from "./canvas-element-helpers.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

// Note: color coercion (number → hex string) moved to runtime handler.
// Gemini cannot represent z.preprocess/z.transform in JSON Schema.

const labelSchema = z
  .object({
    text: z.string().min(1).describe("Label text centered inside the shape"),
    fontSize: z.number().default(20).describe("Label font size"),
    strokeColor: z.string().default("#000000").describe("Label text color hex"),
  })
  .optional()
  .describe("Optional centered text label inside the shape");

// Flat object schema — Gemini doesn't support union/oneOf/anyOf in tool params.
// All fields are optional; which ones are required depends on `action`.
export const canvasOperationSchema = z
  .object({
    action: z
      .enum([
        "move",
        "resize",
        "delete",
        "update_style",
        "add_text",
        "add_shape",
        "add_line",
        "reorder",
        "align",
        "distribute",
        "update_text",
      ])
      .describe("The operation to perform"),

    // Common: target element ID (move, resize, delete, update_style, reorder)
    element_id: z.string().optional().describe("ID of element to operate on"),

    // Position / size
    x: z.number().optional().describe("X coordinate"),
    y: z.number().optional().describe("Y coordinate"),
    width: z.number().optional().describe("Width"),
    height: z.number().optional().describe("Height"),

    // Style (update_style, add_shape, add_line, add_text)
    strokeColor: z
      .string()
      .optional()
      .describe("Stroke/text color hex, e.g. #FF0000"),
    backgroundColor: z.string().optional().describe("Fill color hex"),
    opacity: z.number().optional().describe("Opacity 0-100"),
    fontSize: z.number().optional().describe("Font size"),
    strokeWidth: z.number().optional().describe("Stroke width"),
    fillStyle: z
      .enum(["solid", "hachure", "cross-hatch"])
      .optional()
      .describe("Fill style"),

    // add_text / update_text
    text: z
      .string()
      .optional()
      .describe("Text content (add_text / update_text)"),

    // add_shape
    shape: z
      .enum(["rectangle", "ellipse", "diamond"])
      .optional()
      .describe("Shape type (add_shape)"),
    label: labelSchema,

    // add_line
    line_type: z
      .enum(["line", "arrow"])
      .optional()
      .describe("Line or arrow (add_line)"),
    points: z
      .array(z.object({ x: z.number(), y: z.number() }))
      .optional()
      .describe(
        "Array of {x,y} points (add_line, optional when using bindings)",
      ),
    start_element_id: z
      .string()
      .optional()
      .describe("Bind arrow start to this element ID"),
    end_element_id: z
      .string()
      .optional()
      .describe("Bind arrow end to this element ID"),

    // reorder
    position: z
      .enum(["front", "back"])
      .optional()
      .describe("Bring to front or send to back (reorder)"),

    // align / distribute
    element_ids: z
      .array(z.string())
      .optional()
      .describe("IDs of elements (align/distribute)"),
    alignment: z
      .enum(["left", "right", "center", "top", "bottom", "middle"])
      .optional()
      .describe("Alignment direction (align)"),
    direction: z
      .enum(["horizontal", "vertical"])
      .optional()
      .describe("Distribution direction (distribute)"),
  })
  .strict();

export const manipulateCanvasSchema = z
  .object({
    operations: z
      .array(canvasOperationSchema)
      .min(1)
      .max(100)
      .describe("List of operations to apply"),
  })
  .strict();

// The LLM tool keeps the flat schema above because Gemini rejects oneOf/anyOf.
const identifierSchema = z.string().trim().min(1).max(200);
const coordinateSchema = z.number().finite();
const positiveSchema = z.number().finite().positive();
const opacitySchema = z.number().finite().min(0).max(100);
const colorSchema = z.string().trim().min(1).max(100);
const strictLabelSchema = z
  .object({
    text: z.string().min(1).max(10_000),
    fontSize: positiveSchema.default(20),
    strokeColor: colorSchema.default("#000000"),
  })
  .strict();

export const strictCanvasOperationSchema = z
  .discriminatedUnion("action", [
    z
      .object({
        action: z.literal("move"),
        element_id: identifierSchema,
        x: coordinateSchema,
        y: coordinateSchema,
      })
      .strict(),
    z
      .object({
        action: z.literal("resize"),
        element_id: identifierSchema,
        width: positiveSchema,
        height: positiveSchema,
      })
      .strict(),
    z
      .object({ action: z.literal("delete"), element_id: identifierSchema })
      .strict(),
    z
      .object({
        action: z.literal("update_style"),
        element_id: identifierSchema,
        strokeColor: colorSchema.optional(),
        backgroundColor: colorSchema.optional(),
        opacity: opacitySchema.optional(),
        fontSize: positiveSchema.optional(),
        strokeWidth: positiveSchema.optional(),
        fillStyle: z.enum(["solid", "hachure", "cross-hatch"]).optional(),
      })
      .strict(),
    z
      .object({
        action: z.literal("add_text"),
        text: z.string().min(1).max(10_000),
        x: coordinateSchema,
        y: coordinateSchema,
        strokeColor: colorSchema.optional(),
        fontSize: positiveSchema.optional(),
      })
      .strict(),
    z
      .object({
        action: z.literal("add_shape"),
        shape: z.enum(["rectangle", "ellipse", "diamond"]),
        x: coordinateSchema,
        y: coordinateSchema,
        width: positiveSchema,
        height: positiveSchema,
        strokeColor: colorSchema.optional(),
        backgroundColor: colorSchema.optional(),
        fillStyle: z.enum(["solid", "hachure", "cross-hatch"]).optional(),
        label: strictLabelSchema.optional(),
      })
      .strict(),
    z
      .object({
        action: z.literal("add_line"),
        line_type: z.enum(["line", "arrow"]).default("arrow"),
        points: z
          .array(
            z.object({ x: coordinateSchema, y: coordinateSchema }).strict(),
          )
          .min(2)
          .optional(),
        start_element_id: identifierSchema.optional(),
        end_element_id: identifierSchema.optional(),
        x: coordinateSchema.optional(),
        y: coordinateSchema.optional(),
        strokeColor: colorSchema.optional(),
        strokeWidth: positiveSchema.optional(),
      })
      .strict(),
    z
      .object({
        action: z.literal("reorder"),
        element_id: identifierSchema,
        position: z.enum(["front", "back"]),
      })
      .strict(),
    z
      .object({
        action: z.literal("align"),
        element_ids: z.array(identifierSchema).min(2).max(100),
        alignment: z.enum([
          "left",
          "right",
          "center",
          "top",
          "bottom",
          "middle",
        ]),
      })
      .strict(),
    z
      .object({
        action: z.literal("distribute"),
        element_ids: z.array(identifierSchema).min(3).max(100),
        direction: z.enum(["horizontal", "vertical"]),
      })
      .strict(),
    z
      .object({
        action: z.literal("update_text"),
        element_id: identifierSchema,
        text: z.string().min(1).max(10_000),
        fontSize: positiveSchema.optional(),
      })
      .strict(),
  ])
  .superRefine((operation, context) => {
    if (
      operation.action === "update_style" &&
      Object.keys(operation).length === 2
    ) {
      context.addIssue({
        code: "custom",
        message: "At least one style field is required.",
      });
    }
    if (
      operation.action === "add_line" &&
      !operation.points &&
      !operation.start_element_id &&
      !operation.end_element_id
    ) {
      context.addIssue({
        code: "custom",
        message: "Line points or a binding are required.",
      });
    }
  });

const strictCanvasOperationsSchema = z
  .array(strictCanvasOperationSchema)
  .min(1)
  .max(100);
export type CanvasOperation = z.infer<typeof strictCanvasOperationSchema>;
type Operation = z.infer<typeof canvasOperationSchema>;
export type CanvasOperationIssue = { index: number; message: string };

export class CanvasOperationError extends Error {
  readonly code = "invalid_request";
  readonly statusCode = 400;
  readonly issues: CanvasOperationIssue[];

  constructor(issues: CanvasOperationIssue[]) {
    super("Invalid canvas operations.");
    this.name = "CanvasOperationError";
    this.issues = issues.slice(0, 20).map((issue) => ({ ...issue }));
  }
}

export function parseCanvasOperations(input: unknown): CanvasOperation[] {
  const parsed = strictCanvasOperationsSchema.safeParse(input);
  if (!parsed.success) {
    throw new CanvasOperationError(
      parsed.error.issues.slice(0, 20).map((issue) => ({
        index: typeof issue.path[0] === "number" ? issue.path[0] : 0,
        message: issue.message.slice(0, 200),
      })),
    );
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Operation handlers
// ---------------------------------------------------------------------------

function applyMove(elements: CanvasElement[], op: Operation): HandlerResult {
  const el = findElement(elements, op.element_id!);
  if (!el) return { description: `[skip] element ${op.element_id} not found` };
  el.x = op.x;
  el.y = op.y;
  bumpVersion(el);
  return { description: `moved ${shortLabel(el)} to (${op.x}, ${op.y})` };
}

function applyResize(elements: CanvasElement[], op: Operation): HandlerResult {
  const el = findElement(elements, op.element_id!);
  if (!el) return { description: `[skip] element ${op.element_id} not found` };
  el.width = op.width;
  el.height = op.height;
  bumpVersion(el);
  return {
    description: `resized ${shortLabel(el)} to ${op.width}x${op.height}`,
  };
}

/**
 * Delete an element with full cascade:
 * - Marks the target as deleted
 * - Cascades deletion to bound text elements (label cleanup)
 * - Clears startBinding / endBinding on arrows pointing to deleted element
 */
function applyDelete(elements: CanvasElement[], op: Operation): HandlerResult {
  const el = findElement(elements, op.element_id!);
  if (!el) return { description: `[skip] element ${op.element_id} not found` };
  el.isDeleted = true;
  bumpVersion(el);

  const cascaded: string[] = [];

  // Cascade to bound text children (labels)
  if (Array.isArray(el.boundElements)) {
    for (const bound of el.boundElements as Array<{
      type: string;
      id: string;
    }>) {
      if (bound.type === "text") {
        const textEl = findElement(elements, bound.id);
        if (textEl) {
          textEl.isDeleted = true;
          bumpVersion(textEl);
          cascaded.push(`text(${bound.id})`);
        }
      }
    }
  }

  // Clean up arrow bindings pointing at the deleted element
  for (const other of elements) {
    if (other.isDeleted) continue;
    const startBinding = other.startBinding as { elementId: string } | null;
    const endBinding = other.endBinding as { elementId: string } | null;
    if (startBinding?.elementId === op.element_id) {
      other.startBinding = null;
      bumpVersion(other);
    }
    if (endBinding?.elementId === op.element_id) {
      other.endBinding = null;
      bumpVersion(other);
    }
  }

  const cascadeInfo =
    cascaded.length > 0 ? ` (cascaded: ${cascaded.join(", ")})` : "";
  return { description: `deleted ${shortLabel(el)}${cascadeInfo}` };
}

function applyUpdateStyle(
  elements: CanvasElement[],
  op: Operation,
): HandlerResult {
  const el = findElement(elements, op.element_id!);
  if (!el) return { description: `[skip] element ${op.element_id} not found` };

  const applied: string[] = [];
  const props = [
    "strokeColor",
    "backgroundColor",
    "opacity",
    "fontSize",
    "strokeWidth",
    "fillStyle",
  ] as const;
  for (const key of props) {
    if (op[key] !== undefined) {
      el[key] = op[key];
      applied.push(key);
    }
  }
  bumpVersion(el);
  return {
    description: `updated ${shortLabel(el)} style: ${applied.join(", ")}`,
  };
}

function applyAddText(elements: CanvasElement[], op: Operation): HandlerResult {
  const id = generateId();
  const text = op.text as string;
  const el: CanvasElement = {
    ...createElementBase(),
    id,
    type: "text",
    text,
    x: op.x,
    y: op.y,
    width: measureTextWidth(text, op.fontSize ?? 20),
    height: (op.fontSize ?? 20) * 1.25,
    fontSize: op.fontSize ?? 20,
    fontFamily: 1,
    textAlign: "left",
    verticalAlign: "top",
    strokeColor: op.strokeColor ?? "#000000",
    containerId: null,
    originalText: text,
    autoResize: true,
    lineHeight: 1.25,
  };
  elements.push(el);
  const short = text.length > 20 ? `${text.slice(0, 17)}...` : text;
  return {
    description: `added text '${short}' at (${op.x}, ${op.y}) [id=${id}]`,
    createdId: id,
  };
}

/**
 * Update the text content of a standalone text element or a shape's label.
 * Resizes the text element and expands the container if needed.
 */
function applyUpdateText(
  elements: CanvasElement[],
  op: Operation,
): HandlerResult {
  const el = findElement(elements, op.element_id!);
  if (!el) return { description: `[skip] element ${op.element_id} not found` };

  let textEl: CanvasElement | undefined;
  if (el.type === "text") {
    textEl = el;
  } else if (Array.isArray(el.boundElements)) {
    const boundText = (
      el.boundElements as Array<{ type: string; id: string }>
    ).find((b) => b.type === "text");
    if (boundText) textEl = findElement(elements, boundText.id);
  }

  if (!textEl)
    return { description: `[skip] no text found for element ${op.element_id}` };

  const newText = op.text!;
  const fontSize = (op.fontSize ?? textEl.fontSize ?? 20) as number;
  textEl.text = newText;
  textEl.originalText = newText;

  const lines = newText.split("\n");
  const textWidth = Math.max(
    ...lines.map((l) => measureTextWidth(l, fontSize)),
  );
  const textHeight = lines.length * fontSize * 1.25;
  textEl.width = textWidth;
  textEl.height = textHeight;

  if (op.fontSize !== undefined) textEl.fontSize = fontSize;
  bumpVersion(textEl);

  // Expand container if text no longer fits
  const containerId = textEl.containerId as string | null;
  if (containerId) {
    const container = findElement(elements, containerId);
    if (container) {
      const paddingX = Math.max(fontSize * 1.5, 30);
      const paddingY = Math.max(fontSize * 1.2, 24);
      const minWidth = textWidth + paddingX * 2;
      const minHeight = textHeight + paddingY * 2;
      let resized = false;
      if ((Number(container.width) || 0) < minWidth) {
        container.width = minWidth;
        resized = true;
      }
      if ((Number(container.height) || 0) < minHeight) {
        container.height = minHeight;
        resized = true;
      }
      if (resized) {
        // Re-center text within the (possibly expanded) container
        textEl.x =
          Number(container.x) + (Number(container.width) - textWidth) / 2;
        textEl.y =
          Number(container.y) + (Number(container.height) - textHeight) / 2;
        bumpVersion(container);
      }
    }
  }

  const short = newText.length > 20 ? `${newText.slice(0, 17)}...` : newText;
  return { description: `updated text to '${short}' on ${op.element_id}` };
}

/**
 * Add a shape with optional centered label.
 * Uses proportional padding based on fontSize to ensure text never overflows.
 * Enforces absolute minimum sizes per shape type.
 */
function applyAddShape(
  elements: CanvasElement[],
  op: Operation,
): HandlerResult {
  const shapeId = generateId();
  const el: CanvasElement = {
    ...createElementBase(),
    id: shapeId,
    type: op.shape,
    x: op.x,
    y: op.y,
    width: op.width,
    height: op.height,
    strokeColor: coerceColor(op.strokeColor, "#000000"),
    backgroundColor: coerceColor(op.backgroundColor, "transparent"),
    fillStyle: op.fillStyle ?? "solid",
  };

  if (op.label) {
    const textId = generateId();
    const fontSize = op.label.fontSize;

    // For multi-line labels, measure the longest line and compute total height
    const lines = op.label.text.split("\n");
    const textWidth = Math.max(
      ...lines.map((l) => measureTextWidth(l, fontSize)),
    );
    const textHeight = lines.length * fontSize * 1.25;

    // Proportional padding — scales with font size to avoid overflow at any size
    const paddingX = Math.max(fontSize * 1.5, 30);
    const paddingY = Math.max(fontSize * 1.2, 24);
    const minWidth = textWidth + paddingX * 2;
    const minHeight = textHeight + paddingY * 2;

    // Enforce minimum shape size so text never overflows, plus absolute floor
    el.width = Math.max(Number(el.width) || 0, minWidth, 120);
    el.height = Math.max(Number(el.height) || 0, minHeight, 60);

    // Bind text to shape
    ensureBoundElements(el).push({ type: "text", id: textId });

    const textEl: CanvasElement = {
      ...createElementBase(),
      id: textId,
      type: "text",
      text: op.label.text,
      originalText: op.label.text,
      x: Number(el.x) + (Number(el.width) - textWidth) / 2,
      y: Number(el.y) + (Number(el.height) - textHeight) / 2,
      width: textWidth,
      height: textHeight,
      fontSize,
      fontFamily: 1,
      textAlign: "center",
      verticalAlign: "middle",
      strokeColor: coerceColor(op.label.strokeColor, "#000000"),
      containerId: shapeId,
      autoResize: true,
      lineHeight: 1.25,
    };

    elements.push(el);
    elements.push(textEl);

    const short =
      op.label.text.length > 20
        ? `${op.label.text.slice(0, 17)}...`
        : op.label.text;
    return {
      description: `added ${op.shape} ${el.width}x${el.height} with label '${short}' at (${op.x}, ${op.y}) [id=${shapeId}]`,
      createdId: shapeId,
    };
  }

  // No label — enforce minimum sizes per shape type
  const shapeType = op.shape as string;
  if (shapeType === "ellipse") {
    el.width = Math.max(Number(el.width) || 0, 140);
    el.height = Math.max(Number(el.height) || 0, 70);
  } else {
    el.width = Math.max(Number(el.width) || 0, 120);
    el.height = Math.max(Number(el.height) || 0, 60);
  }

  elements.push(el);
  return {
    description: `added ${op.shape} ${el.width}x${el.height} at (${op.x}, ${op.y}) [id=${shapeId}]`,
    createdId: shapeId,
  };
}

function applyAddLine(elements: CanvasElement[], op: Operation): HandlerResult {
  const hasBinding = op.start_element_id || op.end_element_id;

  if (hasBinding) {
    return applyAddBoundLine(elements, op);
  }

  // Non-binding path: points are required
  if (!op.points || op.points.length < 2) {
    return {
      description: "[skip] add_line without bindings requires points (>= 2)",
    };
  }

  // Auto-derive origin from first point if x/y not provided.
  // Excalidraw stores points relative to the element's x/y origin.
  const firstPoint = op.points[0] as { x: number; y: number };
  const originX = op.x ?? firstPoint.x;
  const originY = op.y ?? firstPoint.y;
  const excalidrawPoints = op.points.map((p) => [p.x - originX, p.y - originY]);

  const relXs = excalidrawPoints.map((p) => p[0]!);
  const relYs = excalidrawPoints.map((p) => p[1]!);
  const width = Math.abs(Math.max(...relXs) - Math.min(...relXs));
  const height = Math.abs(Math.max(...relYs) - Math.min(...relYs));

  const arrowId = generateId();
  const el: CanvasElement = {
    ...createElementBase(),
    id: arrowId,
    type: op.line_type ?? "arrow",
    x: originX,
    y: originY,
    width,
    height,
    points: excalidrawPoints,
    strokeColor: coerceColor(op.strokeColor, "#000000"),
    strokeWidth: op.strokeWidth ?? 2,
    lastCommittedPoint: excalidrawPoints[excalidrawPoints.length - 1],
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: op.line_type === "arrow" ? "arrow" : null,
  };
  elements.push(el);
  return {
    description: `added ${op.line_type} with ${op.points.length} points at (${originX}, ${originY}) [id=${arrowId}]`,
    createdId: arrowId,
  };
}

/**
 * Add an arrow/line with element bindings.
 * Uses computeFixedPoint to set stable fixedPoint values so Excalidraw does
 * not recompute endpoints when bound shapes are resized.
 */
function applyAddBoundLine(
  elements: CanvasElement[],
  op: Operation,
): HandlerResult {
  const startEl = op.start_element_id
    ? findElement(elements, op.start_element_id)
    : null;
  const endEl = op.end_element_id
    ? findElement(elements, op.end_element_id)
    : null;

  if (op.start_element_id && !startEl) {
    return {
      description: `[skip] start element ${op.start_element_id} not found`,
    };
  }
  if (op.end_element_id && !endEl) {
    return {
      description: `[skip] end element ${op.end_element_id} not found`,
    };
  }

  const startCenter = startEl
    ? getElementCenter(startEl)
    : { cx: op.x ?? 0, cy: op.y ?? 0 };
  const endCenter = endEl
    ? getElementCenter(endEl)
    : { cx: (op.x ?? 0) + 100, cy: op.y ?? 0 };

  const startPoint = startEl
    ? computeEdgePoint(startEl, { x: endCenter.cx, y: endCenter.cy })
    : { x: startCenter.cx, y: startCenter.cy };

  const endPoint = endEl
    ? computeEdgePoint(endEl, { x: startCenter.cx, y: startCenter.cy })
    : { x: endCenter.cx, y: endCenter.cy };

  const arrowId = generateId();
  const relEnd = {
    x: endPoint.x - startPoint.x,
    y: endPoint.y - startPoint.y,
  };

  let startBinding: unknown = null;
  let endBinding: unknown = null;

  if (startEl) {
    const fixedPoint = endEl
      ? computeFixedPoint(startEl, endEl)
      : ([1, 0.5] as [number, number]);
    startBinding = {
      elementId: op.start_element_id,
      focus: 0,
      gap: BINDING_GAP,
      fixedPoint,
    };
    ensureBoundElements(startEl).push({ type: "arrow", id: arrowId });
    bumpVersion(startEl);
  }

  if (endEl) {
    const fixedPoint = startEl
      ? computeFixedPoint(endEl, startEl)
      : ([0, 0.5] as [number, number]);
    endBinding = {
      elementId: op.end_element_id,
      focus: 0,
      gap: BINDING_GAP,
      fixedPoint,
    };
    ensureBoundElements(endEl).push({ type: "arrow", id: arrowId });
    bumpVersion(endEl);
  }

  const el: CanvasElement = {
    ...createElementBase(),
    id: arrowId,
    type: op.line_type ?? "arrow",
    x: startPoint.x,
    y: startPoint.y,
    width: Math.abs(relEnd.x),
    height: Math.abs(relEnd.y),
    points: [
      [0, 0],
      [relEnd.x, relEnd.y],
    ],
    strokeColor: coerceColor(op.strokeColor, "#000000"),
    strokeWidth: op.strokeWidth ?? 2,
    lastCommittedPoint: [relEnd.x, relEnd.y],
    startBinding,
    endBinding,
    startArrowhead: null,
    endArrowhead: op.line_type === "arrow" || !op.line_type ? "arrow" : null,
  };
  elements.push(el);

  const fromLabel = op.start_element_id ?? "free";
  const toLabel = op.end_element_id ?? "free";
  return {
    description: `added bound ${op.line_type ?? "arrow"} ${fromLabel} → ${toLabel} [id=${arrowId}]`,
    createdId: arrowId,
  };
}

function applyReorder(elements: CanvasElement[], op: Operation): HandlerResult {
  const idx = elements.findIndex(
    (el) => el.id === op.element_id && !el.isDeleted,
  );
  if (idx === -1)
    return { description: `[skip] element ${op.element_id} not found` };

  const removed = elements.splice(idx, 1);
  const el = removed[0]!;
  if (op.position === "front") {
    elements.push(el);
  } else {
    elements.unshift(el);
  }
  bumpVersion(el);
  return { description: `reordered ${shortLabel(el)} to ${op.position}` };
}

function applyAlign(elements: CanvasElement[], op: Operation): HandlerResult {
  const targets = (op.element_ids ?? [])
    .map((id) => findElement(elements, id))
    .filter((el): el is CanvasElement => el !== undefined);

  if (targets.length < 2) {
    return {
      description: `[skip] need >= 2 valid elements to align, found ${targets.length}`,
    };
  }

  switch (op.alignment) {
    case "left": {
      const minX = Math.min(...targets.map((el) => Number(el.x) || 0));
      for (const el of targets) {
        el.x = minX;
        bumpVersion(el);
      }
      break;
    }
    case "right": {
      const maxRight = Math.max(
        ...targets.map((el) => (Number(el.x) || 0) + (Number(el.width) || 0)),
      );
      for (const el of targets) {
        el.x = maxRight - (Number(el.width) || 0);
        bumpVersion(el);
      }
      break;
    }
    case "center": {
      const centers = targets.map(
        (el) => (Number(el.x) || 0) + (Number(el.width) || 0) / 2,
      );
      const avg = centers.reduce((a, b) => a + b, 0) / centers.length;
      for (const el of targets) {
        el.x = avg - (Number(el.width) || 0) / 2;
        bumpVersion(el);
      }
      break;
    }
    case "top": {
      const minY = Math.min(...targets.map((el) => Number(el.y) || 0));
      for (const el of targets) {
        el.y = minY;
        bumpVersion(el);
      }
      break;
    }
    case "bottom": {
      const maxBottom = Math.max(
        ...targets.map((el) => (Number(el.y) || 0) + (Number(el.height) || 0)),
      );
      for (const el of targets) {
        el.y = maxBottom - (Number(el.height) || 0);
        bumpVersion(el);
      }
      break;
    }
    case "middle": {
      const middles = targets.map(
        (el) => (Number(el.y) || 0) + (Number(el.height) || 0) / 2,
      );
      const avg = middles.reduce((a, b) => a + b, 0) / middles.length;
      for (const el of targets) {
        el.y = avg - (Number(el.height) || 0) / 2;
        bumpVersion(el);
      }
      break;
    }
  }

  return {
    description: `aligned ${targets.length} elements ${op.alignment}`,
  };
}

function applyDistribute(
  elements: CanvasElement[],
  op: Operation,
): HandlerResult {
  const targets = (op.element_ids ?? [])
    .map((id) => findElement(elements, id))
    .filter((el): el is CanvasElement => el !== undefined);

  if (targets.length < 3) {
    return {
      description: `[skip] need >= 3 valid elements to distribute, found ${targets.length}`,
    };
  }

  if (op.direction === "horizontal") {
    targets.sort((a, b) => (Number(a.x) || 0) - (Number(b.x) || 0));
    const first = targets[0]!;
    const last = targets[targets.length - 1]!;
    const totalSpan =
      (Number(last.x) || 0) +
      (Number(last.width) || 0) -
      (Number(first.x) || 0);
    const totalWidths = targets.reduce(
      (sum, el) => sum + (Number(el.width) || 0),
      0,
    );
    const gap = (totalSpan - totalWidths) / (targets.length - 1);

    let currentX = Number(first.x) || 0;
    for (const el of targets) {
      el.x = currentX;
      bumpVersion(el);
      currentX += (Number(el.width) || 0) + gap;
    }
  } else {
    targets.sort((a, b) => (Number(a.y) || 0) - (Number(b.y) || 0));
    const first = targets[0]!;
    const last = targets[targets.length - 1]!;
    const totalSpan =
      (Number(last.y) || 0) +
      (Number(last.height) || 0) -
      (Number(first.y) || 0);
    const totalHeights = targets.reduce(
      (sum, el) => sum + (Number(el.height) || 0),
      0,
    );
    const gap = (totalSpan - totalHeights) / (targets.length - 1);

    let currentY = Number(first.y) || 0;
    for (const el of targets) {
      el.y = currentY;
      bumpVersion(el);
      currentY += (Number(el.height) || 0) + gap;
    }
  }

  return {
    description: `distributed ${targets.length} elements ${op.direction}ly`,
  };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

const handlers: Record<
  Operation["action"],
  (elements: CanvasElement[], op: any) => HandlerResult
> = {
  move: applyMove,
  resize: applyResize,
  delete: applyDelete,
  update_style: applyUpdateStyle,
  add_text: applyAddText,
  add_shape: applyAddShape,
  add_line: applyAddLine,
  reorder: applyReorder,
  align: applyAlign,
  distribute: applyDistribute,
  update_text: applyUpdateText,
};

export type CanvasOperationEngineResult = {
  content: CanvasContent;
  applied: number;
  descriptions: string[];
  errors: string[];
  issues: CanvasOperationIssue[];
  createdIds: Record<string, string>;
};

/** Applies the existing Agent operation contract without transport or persistence concerns. */
export function applyCanvasOperations(
  content: CanvasContent,
  rawOperations: unknown,
): CanvasOperationEngineResult {
  const operations = parseCanvasOperations(rawOperations);
  const clonedContent = structuredClone(content);
  const elements = (clonedContent.elements ?? []) as CanvasElement[];
  const descriptions: string[] = [];
  const errors: string[] = [];
  const issues: CanvasOperationIssue[] = [];
  const createdIds: Record<string, string> = {};

  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index]!;
    try {
      const result = handlers[operation.action](elements, operation);
      if (result.description.startsWith("[skip]")) {
        errors.push(result.description);
        issues.push({ index, message: result.description.slice(0, 200) });
      } else {
        descriptions.push(result.description);
        if (result.createdId) createdIds[`op_${index}`] = result.createdId;
      }
    } catch (error) {
      const message = `[error] ${operation.action}: ${(error as Error).message}`;
      errors.push(message);
      issues.push({ index, message: message.slice(0, 200) });
    }
  }

  validateBindings(elements);
  // Domain validation is the single boundary that prevents unsupported node
  // types from being persisted through the operation engine.
  for (const element of elements) {
    if (element.isDeleted) continue;
    defaultCanvasNodeRegistry.validate(element);
  }
  return {
    content: { ...clonedContent, elements },
    applied: descriptions.length,
    descriptions,
    errors,
    issues,
    createdIds,
  };
}
