import { afterEach, describe, expect, it, vi } from "vitest";

import {
  blobToDataURL,
  createExcalidrawImageElement,
} from "../src/lib/canvas-elements";

describe("blobToDataURL", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects with a descriptive Error when FileReader fails", async () => {
    class FailingFileReader {
      result: string | ArrayBuffer | null = null;
      onload: (() => void) | null = null;
      onerror: ((event: Event) => void) | null = null;

      readAsDataURL() {
        this.onerror?.(new Event("error"));
      }
    }

    vi.stubGlobal("FileReader", FailingFileReader);

    await expect(blobToDataURL(new Blob(["broken"]))).rejects.toThrow(
      "Failed to convert image to data URL",
    );
  });
});

describe("createExcalidrawImageElement", () => {
  it("preserves the supplied Excalidraw angle", () => {
    expect(
      createExcalidrawImageElement({
        fileId: "file-1",
        x: 10,
        y: 20,
        width: 300,
        height: 200,
        angle: Math.PI / 2,
      }).angle,
    ).toBe(Math.PI / 2);
  });
});
