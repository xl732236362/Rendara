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

    render(<CanvasToolMenu accessToken="token" excalidrawApi={api} />);

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

    render(<CanvasToolMenu accessToken="token" excalidrawApi={api} />);

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

  it("replaces the placeholder even when the editor panel unmounts", async () => {
    const generation = deferred<{
      url: string;
      prompt: string;
      mimeType: string;
      width: number;
      height: number;
    }>();
    generateImageDirectMock.mockReturnValue(generation.promise);
    fetchAsDataURLMock.mockResolvedValue("data:image/png;base64,dGVzdA==");

    let elements: Array<Record<string, unknown>> = [
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
      addFiles: vi.fn(),
      getSceneElements: vi.fn(() => elements),
      updateScene: vi.fn(
        (scene: { elements?: Array<Record<string, unknown>> }) => {
          if (scene.elements) elements = scene.elements;
        },
      ),
    };

    const view = render(
      <ImageGeneratorPanel
        elementId="generator-1"
        elementBounds={{ x: 10, y: 20, width: 400, height: 400 }}
        data={elements[0]?.customData as ImageGeneratorData}
        excalidrawApi={api}
        accessToken="token"
        canvasScrollZoom={{ scrollX: 0, scrollY: 0, zoom: 1 }}
        onClose={vi.fn()}
      />,
    );

    fireEvent.keyDown(screen.getByPlaceholderText("今天我们要创作什么"), {
      key: "Enter",
    });
    await waitFor(() => expect(generateImageDirectMock).toHaveBeenCalledOnce());

    view.unmount();
    elements = elements.map((element) =>
      element.id === "generator-1"
        ? {
            ...element,
            x: 110,
            y: 120,
            width: 640,
            height: 360,
            angle: Math.PI / 3,
          }
        : element,
    );
    generation.resolve({
      url: "https://example.test/generated.png",
      prompt: "A test image",
      mimeType: "image/png",
      width: 1024,
      height: 1024,
    });

    await waitFor(() => expect(fetchAsDataURLMock).toHaveBeenCalledOnce());
    expect(api.addFiles).toHaveBeenCalledOnce();
    expect(elements.some((element) => element.type === "image")).toBe(true);
    expect(
      elements.find((element) => element.id === "generator-1")?.isDeleted,
    ).toBe(true);
    expect(elements.find((element) => element.type === "image")).toMatchObject({
      x: 110,
      y: 120,
      width: 640,
      height: 360,
      angle: Math.PI / 3,
    });
  });

  it("does not recreate a generator deleted while generation is pending", async () => {
    const generation = deferred<{
      url: string;
      prompt: string;
      mimeType: string;
      width: number;
      height: number;
    }>();
    generateImageDirectMock.mockReturnValue(generation.promise);
    fetchAsDataURLMock.mockResolvedValue("data:image/png;base64,dGVzdA==");

    let elements: Array<Record<string, unknown>> = [
      {
        id: "deleted-generator",
        type: "rectangle",
        x: 10,
        y: 20,
        width: 400,
        height: 400,
        angle: 0,
        version: 1,
        customData: {
          type: "image-generator",
          status: "idle",
          prompt: "A deleted test image",
          model: "gpt-image-2",
          aspectRatio: "1:1",
          quality: "standard",
        },
      },
    ];
    const api = {
      addFiles: vi.fn(),
      getSceneElements: vi.fn(() => elements),
      updateScene: vi.fn(
        (scene: { elements?: Array<Record<string, unknown>> }) => {
          if (scene.elements) elements = scene.elements;
        },
      ),
    };

    render(
      <ImageGeneratorPanel
        elementId="deleted-generator"
        elementBounds={{ x: 10, y: 20, width: 400, height: 400, angle: 0 }}
        data={elements[0]?.customData as ImageGeneratorData}
        excalidrawApi={api}
        accessToken="token"
        canvasScrollZoom={{ scrollX: 0, scrollY: 0, zoom: 1 }}
        onClose={vi.fn()}
      />,
    );

    fireEvent.keyDown(screen.getByPlaceholderText("今天我们要创作什么"), {
      key: "Enter",
    });
    await waitFor(() => expect(generateImageDirectMock).toHaveBeenCalledOnce());
    elements = elements.map((element) =>
      element.id === "deleted-generator"
        ? { ...element, isDeleted: true }
        : element,
    );

    generation.resolve({
      url: "https://example.test/generated.png",
      prompt: "A deleted test image",
      mimeType: "image/png",
      width: 1024,
      height: 1024,
    });

    await waitFor(() => expect(fetchAsDataURLMock).toHaveBeenCalledOnce());
    await waitFor(() => expect(generateImageDirectMock).toHaveBeenCalledOnce());
    expect(api.addFiles).not.toHaveBeenCalled();
    expect(elements.some((element) => element.type === "image")).toBe(false);
  });

  it("recovers an orphaned generating placeholder as retryable", async () => {
    let elements: Array<Record<string, unknown>> = [
      {
        id: "orphaned-generator",
        type: "rectangle",
        x: 10,
        y: 20,
        width: 400,
        height: 400,
        version: 1,
        customData: {
          type: "image-generator",
          status: "generating",
          prompt: "A test image",
          model: "gpt-image-2",
          aspectRatio: "1:1",
          quality: "standard",
        },
      },
    ];
    const api = {
      addFiles: vi.fn(),
      getSceneElements: vi.fn(() => elements),
      updateScene: vi.fn(
        (scene: { elements?: Array<Record<string, unknown>> }) => {
          if (scene.elements) elements = scene.elements;
        },
      ),
    };

    render(
      <ImageGeneratorPanel
        elementId="orphaned-generator"
        elementBounds={{ x: 10, y: 20, width: 400, height: 400 }}
        data={elements[0]?.customData as ImageGeneratorData}
        excalidrawApi={api}
        accessToken="token"
        canvasScrollZoom={{ scrollX: 0, scrollY: 0, zoom: 1 }}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(
        (
          elements.find((element) => element.id === "orphaned-generator")
            ?.customData as Record<string, unknown>
        ).status,
      ).toBe("error");
    });
    expect(screen.getByPlaceholderText("今天我们要创作什么")).toBeEnabled();
    expect(screen.getByText("上次生成已中断，请重试。")).toBeInTheDocument();
  });
});
