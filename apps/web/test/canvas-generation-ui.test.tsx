// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { fetchAsDataURLMock, generateImageDirectMock } = vi.hoisted(() => ({
  fetchAsDataURLMock: vi.fn(),
  generateImageDirectMock: vi.fn(),
}));

vi.mock("../src/lib/server-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/server-api")>()),
  fetchImageModels: vi.fn().mockResolvedValue({ models: [] }),
  generateImageDirect: generateImageDirectMock,
}));

vi.mock("../src/lib/canvas-elements", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/canvas-elements")>()),
  fetchAsDataURL: fetchAsDataURLMock,
}));

vi.mock("../src/hooks/use-generation-error-handler", () => ({
  useGenerationErrorHandler: () => ({
    handleGenerationError: vi.fn(() => false),
  }),
}));

import { CanvasToolMenu } from "../src/components/canvas-tool-menu";
import { ImageGeneratorPanel } from "../src/components/canvas/image-generator-panel";
import type { ImageGeneratorData } from "../src/lib/canvas-image-generator";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("canvas image generation UI", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("keeps the generating overlay bound through canvas and node transforms", async () => {
    let onChange:
      | ((elements: unknown[], appState: Record<string, unknown>) => void)
      | undefined;
    const api = {
      onChange: vi.fn((callback) => {
        onChange = callback;
        return vi.fn();
      }),
    };

    render(
      <CanvasToolMenu
        accessToken="token"
        projectId="project-1"
        startImageGeneration={vi.fn()}
        excalidrawApi={api}
      />,
    );

    act(() => {
      onChange?.(
        [
          {
            id: "generator-1",
            type: "rectangle",
            x: 20,
            y: 30,
            width: 100,
            height: 50,
            angle: 0,
            isDeleted: false,
            customData: {
              type: "image-generator",
              status: "generating",
              model: "gpt-image-2",
            },
          },
        ],
        {
          activeTool: { type: "selection" },
          offsetLeft: 400,
          offsetTop: 12,
          scrollX: 10,
          scrollY: -5,
          selectedElementIds: {},
          zoom: { value: 2 },
        },
      );
    });

    const overlay = await screen.findByText("Generating...");
    const overlayContainer = overlay.parentElement?.parentElement;
    expect(overlayContainer).toHaveStyle({
      left: "460px",
      top: "62px",
      width: "200px",
      height: "100px",
      transform: "rotate(0rad)",
      transformOrigin: "center",
    });

    act(() => {
      onChange?.(
        [
          {
            id: "generator-1",
            type: "rectangle",
            x: 20,
            y: 30,
            width: 100,
            height: 50,
            angle: 0,
            isDeleted: false,
            customData: {
              type: "image-generator",
              status: "generating",
              model: "gpt-image-2",
            },
          },
        ],
        {
          activeTool: { type: "selection" },
          offsetLeft: 100,
          offsetTop: 20,
          scrollX: -10,
          scrollY: 5,
          selectedElementIds: {},
          zoom: { value: 1.5 },
        },
      );
    });

    expect(overlayContainer).toHaveStyle({
      left: "115px",
      top: "72.5px",
      width: "150px",
      height: "75px",
    });

    act(() => {
      onChange?.(
        [
          {
            id: "generator-1",
            type: "rectangle",
            x: 30,
            y: 40,
            width: 120,
            height: 60,
            angle: Math.PI / 2,
            isDeleted: false,
            customData: {
              type: "image-generator",
              status: "generating",
              model: "gpt-image-2",
            },
          },
        ],
        {
          activeTool: { type: "selection" },
          offsetLeft: 100,
          offsetTop: 20,
          scrollX: -10,
          scrollY: 5,
          selectedElementIds: {},
          zoom: { value: 1.5 },
        },
      );
    });

    expect(overlayContainer).toHaveStyle({
      left: "130px",
      top: "87.5px",
      width: "180px",
      height: "90px",
      transform: `rotate(${Math.PI / 2}rad)`,
      transformOrigin: "center",
    });
  });

  it("anchors the editor panel below a rotated generator", async () => {
    let onChange:
      | ((elements: unknown[], appState: Record<string, unknown>) => void)
      | undefined;
    const api = {
      onChange: vi.fn((callback) => {
        onChange = callback;
        return vi.fn();
      }),
    };

    render(
      <CanvasToolMenu
        accessToken="token"
        projectId="project-1"
        startImageGeneration={vi.fn()}
        excalidrawApi={api}
      />,
    );

    act(() => {
      onChange?.(
        [
          {
            id: "generator-1",
            type: "rectangle",
            x: 20,
            y: 30,
            width: 100,
            height: 50,
            angle: Math.PI / 2,
            isDeleted: false,
            customData: {
              type: "image-generator",
              status: "idle",
              prompt: "A test image",
              model: "gpt-image-2",
              aspectRatio: "1:1",
              quality: "standard",
            },
          },
        ],
        {
          activeTool: { type: "selection" },
          offsetLeft: 400,
          offsetTop: 12,
          scrollX: 10,
          scrollY: -5,
          selectedElementIds: { "generator-1": true },
          zoom: { value: 2 },
        },
      );
    });

    const textarea = await screen.findByPlaceholderText("今天我们要创作什么");
    expect(textarea.parentElement).toHaveStyle({
      left: "510px",
      top: "220px",
    });
    expect(textarea.parentElement).not.toHaveStyle({
      transform: `rotate(${Math.PI / 2}rad)`,
    });
  });

  it("submits one durable attempt for repeated Enter presses", async () => {
    const elements: Array<Record<string, unknown>> = [
      {
        id: "generator-1",
        type: "rectangle",
        x: 10,
        y: 20,
        width: 400,
        height: 400,
        version: 1,
        customData: {
          type: "image-generator",
          status: "idle",
          prompt: "A test image",
          model: "gpt-image-2",
          aspectRatio: "1:1",
          quality: "standard",
        },
      },
    ];
    const api = {
      getSceneElements: vi.fn(() => elements),
      updateScene: vi.fn(),
    };
    let release!: () => void;
    const startAttempt = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    render(
      <ImageGeneratorPanel
        elementId="generator-1"
        elementBounds={{ x: 10, y: 20, width: 400, height: 400 }}
        data={elements[0]?.customData as ImageGeneratorData}
        excalidrawApi={api}
        accessToken="token"
        projectId="project-1"
        startAttempt={startAttempt}
        canvasScrollZoom={{ scrollX: 0, scrollY: 0, zoom: 1 }}
        onClose={vi.fn()}
      />,
    );

    const prompt = screen.getByPlaceholderText("今天我们要创作什么");
    fireEvent.keyDown(prompt, {
      key: "Enter",
    });
    fireEvent.keyDown(prompt, {
      key: "Enter",
    });
    expect(startAttempt).toHaveBeenCalledOnce();
    expect(startAttempt).toHaveBeenCalledWith("generator-1", {
      prompt: "A test image",
      model: "gpt-image-2",
      aspectRatio: "1:1",
      quality: "standard",
      referenceAssetIds: [],
    });
    expect(generateImageDirectMock).not.toHaveBeenCalled();
    release();
  });
});
