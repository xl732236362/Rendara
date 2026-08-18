import { afterEach, describe, expect, it, vi } from "vitest";

import {
  blobToDataURL,
  createExcalidrawImageElement,
  fetchAsDataURL,
} from "../src/lib/canvas-elements";
import {
  updateImageGeneratorAttempt,
  updateImageGeneratorData,
} from "../src/lib/canvas-image-generator";

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

describe("fetchAsDataURL", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the access token in the Authorization header", async () => {
    class SuccessfulFileReader {
      result: string | ArrayBuffer | null = "data:image/png;base64,aW1hZ2U=";
      onload: (() => void) | null = null;
      onerror: ((event: Event) => void) | null = null;

      readAsDataURL() {
        this.onload?.();
      }
    }
    const fetchMock = vi.fn(
      async () => new Response(new Blob(["image"], { type: "image/png" })),
    );
    vi.stubGlobal("FileReader", SuccessfulFileReader);
    vi.stubGlobal("fetch", fetchMock);

    await fetchAsDataURL("https://replicate.delivery/image.png", "token-1");

    expect(fetchMock).toHaveBeenCalledWith(
      expect.not.stringContaining("token-1"),
      { headers: { Authorization: "Bearer token-1" } },
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

describe("image generator attempt updates", () => {
  const generatingElement = {
    id: "generator-1",
    version: 1,
    customData: {
      type: "image-generator" as const,
      status: "generating" as const,
      prompt: "original prompt",
      model: "image/model",
      aspectRatio: "1:1",
      quality: "hd",
      referenceAssetIds: ["66666666-6666-4666-8666-666666666666"],
      idempotencyKey: "attempt-1",
    },
  };

  it("keeps replayable request fields immutable while generating", () => {
    const updated = updateImageGeneratorData(generatingElement, {
      prompt: "changed prompt",
      model: "other/model",
      aspectRatio: "16:9",
      quality: "standard",
      referenceAssetIds: [],
      errorMessage: "still pending",
    });

    expect(updated.customData).toMatchObject({
      prompt: "original prompt",
      model: "image/model",
      aspectRatio: "1:1",
      quality: "hd",
      referenceAssetIds: ["66666666-6666-4666-8666-666666666666"],
      errorMessage: "still pending",
    });
  });

  it("applies asynchronous updates only to the captured attempt", () => {
    const attached = updateImageGeneratorAttempt(
      generatingElement,
      "attempt-1",
      { jobId: "44444444-4444-4444-8444-444444444444" },
    );
    expect(attached.customData.jobId).toBe(
      "44444444-4444-4444-8444-444444444444",
    );

    const newerElement = {
      ...generatingElement,
      customData: {
        ...generatingElement.customData,
        idempotencyKey: "attempt-2",
      },
    };
    expect(
      updateImageGeneratorAttempt(newerElement, "attempt-1", {
        status: "error",
      }),
    ).toBe(newerElement);
  });
});
