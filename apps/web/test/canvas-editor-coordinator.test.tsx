// @vitest-environment jsdom

import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  excalidrawProps: null as Record<string, any> | null,
  api: null as Record<string, any> | null,
  elements: [{ id: "base", type: "rectangle", version: 1, versionNonce: 11 }],
  appState: {
    viewBackgroundColor: "#ffffff",
    gridModeEnabled: false,
    selectedElementIds: {},
  } as Record<string, unknown>,
  files: {} as Record<string, Record<string, unknown>>,
  saveCanvas: vi.fn(),
  fetchCanvas: vi.fn(),
  uploadThumbnail: vi.fn(),
  exportToBlob: vi.fn(),
}));

vi.mock("next/dynamic", async () => {
  const React = await import("react");
  return {
    default: () =>
      function MockExcalidraw(props: Record<string, any>) {
        harness.excalidrawProps = props;
        React.useEffect(() => {
          props.excalidrawAPI(harness.api);
        }, [props.excalidrawAPI]);
        return React.createElement("div", { "data-testid": "excalidraw" });
      },
  };
});
vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("@excalidraw/excalidraw", () => ({
  Excalidraw: () => null,
  exportToBlob: harness.exportToBlob,
}));
vi.mock("../src/hooks/use-canvas-image-generation", () => ({
  useCanvasImageGeneration: () => ({ startAttempt: vi.fn() }),
}));
vi.mock("../src/components/canvas-tool-menu", () => ({
  CanvasToolMenu: () => null,
}));
vi.mock("../src/lib/server-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/server-api")>()),
  fetchCanvas: harness.fetchCanvas,
  getAssetUrl: vi.fn(),
  saveCanvas: harness.saveCanvas,
  uploadThumbnail: harness.uploadThumbnail,
}));

import { CanvasEditor } from "../src/components/canvas-editor";

function renderEditor() {
  harness.api = {
    getSceneElements: () => harness.elements,
    getAppState: () => harness.appState,
    getFiles: () => harness.files,
    updateScene: vi.fn(({ elements, appState }) => {
      if (elements) harness.elements = elements;
      if (appState) harness.appState = { ...harness.appState, ...appState };
    }),
    addFiles: vi.fn(),
    onChange: vi.fn(() => () => undefined),
  };
  return render(
    <CanvasEditor
      canvasId="11111111-1111-4111-8111-111111111111"
      projectId="22222222-2222-4222-8222-222222222222"
      accessToken="token"
      userId="33333333-3333-4333-8333-333333333333"
      initialRevision={1}
      initialContent={{
        elements: harness.elements,
        appState: harness.appState,
        files: harness.files,
      }}
    />,
  );
}

describe("CanvasEditor persistence coordinator", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    harness.excalidrawProps = null;
    harness.elements = [
      { id: "base", type: "rectangle", version: 1, versionNonce: 11 },
    ];
    harness.appState = {
      viewBackgroundColor: "#ffffff",
      gridModeEnabled: false,
      selectedElementIds: {},
    };
    harness.files = {};
  });

  it("does not save or upload thumbnails for transient callbacks", async () => {
    vi.useFakeTimers();
    harness.saveCanvas.mockResolvedValue({ revision: 2 });
    const view = renderEditor();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2);
    });

    act(() => {
      harness.excalidrawProps?.onChange(harness.elements, {
        ...harness.appState,
        scrollX: 100,
        selectedElementIds: { base: true },
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => {
      harness.excalidrawProps?.onChange(harness.elements, {
        ...harness.appState,
        scrollX: 900,
        selectedElementIds: {},
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });

    expect(harness.saveCanvas).not.toHaveBeenCalled();
    expect(harness.uploadThumbnail).not.toHaveBeenCalled();
    view.unmount();
  });

  it("uploads one thumbnail only after a durable save acknowledgement", async () => {
    vi.useFakeTimers();
    harness.saveCanvas.mockResolvedValue({ revision: 2 });
    harness.exportToBlob.mockResolvedValue(
      new Blob(["preview"], { type: "image/webp" }),
    );
    const view = renderEditor();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2);
    });
    harness.elements = [
      harness.elements[0]!,
      { id: "local", type: "rectangle", version: 1, versionNonce: 22 },
    ];
    act(() => {
      harness.excalidrawProps?.onChange(harness.elements, harness.appState);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.advanceTimersByTimeAsync(0);
    });
    await vi.waitFor(() => expect(harness.saveCanvas).toHaveBeenCalledOnce());
    expect(harness.uploadThumbnail).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(0);
    });
    await vi.waitFor(() =>
      expect(harness.uploadThumbnail).toHaveBeenCalledOnce(),
    );
    view.unmount();
  });
});
