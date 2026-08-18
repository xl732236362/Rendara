import { describe, expect, it, vi } from "vitest";

import { ApiApplicationError, ApiTimeoutError } from "../src/lib/api-client";
import {
  createDurableSceneMutation,
  serializeCanvasFiles,
} from "../src/lib/canvas-persistence";

describe("canvas durable persistence", () => {
  it("serializes generated asset metadata without persisting its runtime data URL", () => {
    expect(
      serializeCanvasFiles({
        "file-1": {
          id: "file-1",
          mimeType: "image/png",
          created: 1,
          assetId: "66666666-6666-4666-8666-666666666666",
          dataURL: "data:image/png;base64,large-runtime-value",
        },
        "file-2": {
          id: "file-2",
          mimeType: "image/png",
          created: 2,
          dataURL: "data:image/png;base64,legacy-inline-value",
        },
      }),
    ).toEqual({
      "file-1": {
        id: "file-1",
        mimeType: "image/png",
        created: 1,
        assetId: "66666666-6666-4666-8666-666666666666",
      },
      "file-2": {
        id: "file-2",
        mimeType: "image/png",
        created: 2,
        dataURL: "data:image/png;base64,legacy-inline-value",
      },
    });
  });

  it("cancels debounce, snapshots the mutation, and waits for acknowledgement", async () => {
    let elements: Record<string, unknown>[] = [{ id: "generator-1", value: 1 }];
    const cancelPendingSave = vi.fn();
    let acknowledge!: () => void;
    const enqueueSave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          acknowledge = resolve;
        }),
    );
    const mutation = createDurableSceneMutation({
      cancelPendingSave,
      getSceneElements: () => elements,
      updateScene: (next) => {
        elements = next;
      },
      buildContent: (next) => ({
        elements: next,
        appState: {},
        files: {},
      }),
      enqueueSave,
    });

    const pending = mutation((current) => [
      ...current,
      { id: "later", value: 2 },
    ]);
    expect(cancelPendingSave).toHaveBeenCalledOnce();
    expect(enqueueSave).toHaveBeenCalledWith({
      elements: [
        { id: "generator-1", value: 1 },
        { id: "later", value: 2 },
      ],
      appState: {},
      files: {},
    });
    let settled = false;
    pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    acknowledge();
    await expect(pending).resolves.toEqual({ kind: "committed" });
  });

  it.each([
    [new ApiTimeoutError(), "ambiguous"],
    [
      new ApiApplicationError("application_error", "failed", { status: 503 }),
      "ambiguous",
    ],
    [
      new ApiApplicationError("canvas_revision_conflict", "conflict", {
        status: 409,
      }),
      "rejected",
    ],
  ] as const)("classifies save failures as %s", async (error, kind) => {
    let elements: Record<string, unknown>[] = [{ id: "original" }];
    const updateScene = vi.fn((next) => {
      elements = next;
    });
    const mutation = createDurableSceneMutation({
      cancelPendingSave: vi.fn(),
      getSceneElements: () => elements,
      updateScene,
      buildContent: () => ({ elements: [], appState: {}, files: {} }),
      enqueueSave: vi.fn().mockRejectedValue(error),
    });

    await expect(
      mutation((current) => [...current, { id: "uncommitted" }]),
    ).resolves.toEqual({ kind });
    expect(elements).toEqual([{ id: "original" }]);
    expect(updateScene).toHaveBeenCalledTimes(2);
  });
});
