// apps/server/src/features/canvas/canvas-element-writer.ts

import type { CanvasContent } from "@loomic/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CanvasElement = Record<string, unknown>;

type ImageInsertOpts = {
  dataURL: string;
  elementId?: string;
  fileId?: string;
  width: number;
  height: number;
  mimeType: string;
  title?: string;
};

type VideoInsertOpts = {
  elementId?: string;
  signedUrl: string; // Public URL for embeddable link
  width: number;
  height: number;
  mimeType: string;
  durationSeconds?: number;
  title?: string;
  prompt?: string;
};

type Placement = { x: number; y: number; width: number; height: number };

type InsertResult = { elementId: string; content: CanvasContent };

// ---------------------------------------------------------------------------
// Placement calculation (ported from apps/web/src/lib/canvas-elements.ts)
// ---------------------------------------------------------------------------

function scaleToFit(
  width: number,
  height: number,
  maxSize: number,
): { width: number; height: number } {
  if (width <= maxSize && height <= maxSize) return { width, height };
  const ratio = Math.min(maxSize / width, maxSize / height);
  return {
    width: Math.round(width * ratio),
    height: Math.round(height * ratio),
  };
}

function calculateAutoPlacement(
  elements: CanvasElement[],
  assetWidth: number,
  assetHeight: number,
  maxSize: number,
): Placement {
  const scaled = scaleToFit(assetWidth, assetHeight, maxSize);
  const visible = elements.filter((el) => !el.isDeleted);

  if (visible.length === 0) {
    // Empty canvas: center around origin
    return {
      x: -scaled.width / 2,
      y: -scaled.height / 2,
      width: scaled.width,
      height: scaled.height,
    };
  }

  // Place right of the rightmost element with 40px gap
  const GAP = 40;
  let maxRight = Number.NEGATIVE_INFINITY;
  let rightEdgeY = 0;
  for (const el of visible) {
    const elRight = (Number(el.x) || 0) + (Number(el.width) || 0);
    if (elRight > maxRight) {
      maxRight = elRight;
      rightEdgeY = (Number(el.y) || 0) + (Number(el.height) || 0) / 2;
    }
  }
  return {
    x: maxRight + GAP,
    y: rightEdgeY - scaled.height / 2,
    width: scaled.width,
    height: scaled.height,
  };
}

// ---------------------------------------------------------------------------
// Element builders
// ---------------------------------------------------------------------------

function generateId(): string {
  return (
    Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
  ).slice(0, 20);
}

function buildImageElement(
  fileId: string,
  placement: Placement,
  opts: ImageInsertOpts,
): CanvasElement {
  return {
    type: "image",
    id: opts.elementId ?? generateId(),
    x: placement.x,
    y: placement.y,
    width: placement.width,
    height: placement.height,
    angle: 0,
    fileId,
    strokeColor: "#000000",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [],
    roundness: null,
    boundElements: null,
    frameId: null,
    index: null,
    seed: Math.floor(Math.random() * 2_000_000_000),
    version: 1,
    versionNonce: Math.floor(Math.random() * 2_000_000_000),
    isDeleted: false,
    updated: Date.now(),
    link: null,
    locked: false,
    status: "saved",
    scale: [1, 1],
    crop: null,
    customData: {
      ...(opts.title ? { title: opts.title } : {}),
      source: "generated" as const,
    },
  };
}

function buildVideoElement(
  placement: Placement,
  opts: VideoInsertOpts,
): CanvasElement {
  return {
    type: "embeddable",
    id: opts.elementId ?? generateId(),
    x: placement.x,
    y: placement.y,
    width: placement.width,
    height: placement.height,
    angle: 0,
    strokeColor: "#000000",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [],
    roundness: null,
    boundElements: null,
    frameId: null,
    index: null,
    seed: Math.floor(Math.random() * 2_000_000_000),
    version: 1,
    versionNonce: Math.floor(Math.random() * 2_000_000_000),
    isDeleted: false,
    updated: Date.now(),
    link: opts.signedUrl,
    locked: false,
    customData: {
      isVideo: true,
      mimeType: opts.mimeType,
      ...(opts.durationSeconds != null
        ? { durationSeconds: opts.durationSeconds }
        : {}),
      ...(opts.title ? { title: opts.title } : {}),
      ...(opts.prompt ? { prompt: opts.prompt } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Public API — Read-Modify-Write canvas content
// ---------------------------------------------------------------------------

const CANVAS_FILES_BUCKET = "project-assets";
const IMAGE_MAX_SIZE = 600;
const VIDEO_MAX_SIZE = 800;

/**
 * Insert an image element into a canvas. Reads current content, appends element
 * with auto-placement (or explicit placement), writes it back.
 *
 * The image file is already in Supabase Storage (uploaded by worker executor).
 * We download it and embed as base64 dataURL in the canvas files map so
 * Excalidraw can render it natively (consistent with frontend-inserted images).
 */
export function insertImageElement(
  content: CanvasContent,
  opts: ImageInsertOpts,
  explicitPlacement?: Placement,
): InsertResult {
  const elements: CanvasElement[] = (content.elements as CanvasElement[]) ?? [];
  const files =
    ((content as any).files as Record<string, Record<string, unknown>>) ?? {};

  // 3. Placement
  const placement =
    explicitPlacement ??
    calculateAutoPlacement(elements, opts.width, opts.height, IMAGE_MAX_SIZE);

  // 4. Build element + files entry with base64 dataURL
  const fileId = opts.fileId ?? generateId();
  const element = buildImageElement(fileId, placement, opts);

  const updatedFiles = {
    ...files,
    [fileId]: {
      id: fileId,
      dataURL: opts.dataURL,
      mimeType: opts.mimeType,
      created: Date.now(),
    },
  };

  const updatedContent = {
    ...content,
    elements: [...elements, element],
    files: updatedFiles,
  };

  return { elementId: element.id as string, content: updatedContent };
}

/**
 * Insert a video element into a canvas. Videos use Excalidraw's `embeddable`
 * type with a link URL — no files map entry needed.
 */
export function insertVideoElement(
  content: CanvasContent,
  opts: VideoInsertOpts,
  explicitPlacement?: Placement,
): InsertResult {
  const elements: CanvasElement[] = (content.elements as CanvasElement[]) ?? [];

  // 2. Placement
  const placement =
    explicitPlacement ??
    calculateAutoPlacement(elements, opts.width, opts.height, VIDEO_MAX_SIZE);

  // 3. Build element
  const element = buildVideoElement(placement, opts);

  const updatedContent = {
    ...content,
    elements: [...elements, element],
  };

  return { elementId: element.id as string, content: updatedContent };
}

export async function prepareImageDataURL(
  client: { storage: { from: (bucket: string) => any } },
  objectPath: string,
  mimeType: string,
): Promise<string> {
  const { data: blob, error } = await client.storage
    .from(CANVAS_FILES_BUCKET)
    .download(objectPath);
  if (error || !blob)
    throw new Error("Generated image could not be loaded from storage.");
  const buffer = Buffer.from(await blob.arrayBuffer());
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}
