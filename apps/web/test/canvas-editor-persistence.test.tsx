import { describe, expect, it, vi } from "vitest";

import {
  ApiApplicationError,
  ApiAuthError,
  ApiTimeoutError,
} from "../src/lib/api-client";
import {
  canonicalJson,
  createCanvasDirtySignatureFactory,
  createCanvasPersistenceCoordinator,
  createDurableSceneMutation,
  normalizeDurableCanvasContent,
  serializeCanvasFiles,
} from "../src/lib/canvas-persistence";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const baseContent = {
  elements: [{ id: "base", version: 1, versionNonce: 11 }],
  appState: { viewBackgroundColor: "#ffffff", gridModeEnabled: false },
  files: {},
};

describe("canvas durable persistence", () => {
  it("canonicalizes durable content without transient app state", () => {
    const normalized = normalizeDurableCanvasContent({
      elements: [
        { version: 1, id: "kept", optional: undefined },
        { id: "deleted", isDeleted: true },
      ],
      appState: {
        scrollX: 200,
        selectedElementIds: { kept: true },
        gridModeEnabled: true,
        viewBackgroundColor: "#fff",
      },
      files: {},
    });

    expect(normalized).toEqual({
      elements: [{ version: 1, id: "kept", optional: undefined }],
      appState: { viewBackgroundColor: "#fff", gridModeEnabled: true },
      files: {},
    });
    expect(canonicalJson({ b: 2, a: [3, { z: undefined, y: 1 }] })).toBe(
      '{"a":[3,{"y":1}],"b":2}',
    );
  });

  it("suppresses identical durable observations", async () => {
    const save = vi.fn(async () => ({ revision: 2 }));
    const coordinator = createCanvasPersistenceCoordinator({
      initial: { revision: 1, content: baseContent },
      save,
      fetch: vi.fn(),
      applyRemote: vi.fn(),
      onConflict: vi.fn(),
      onCommitted: vi.fn(),
    });

    await coordinator.observe({
      ...baseContent,
      appState: {
        ...baseContent.appState,
        scrollX: 500,
        selectedElementIds: { base: true },
      },
    });
    await coordinator.observe(baseContent);

    expect(save).not.toHaveBeenCalled();
    expect(coordinator.pendingUnload()).toBeNull();
  });

  it("uses object identity and durable metadata for a compact dirty signature", () => {
    const signature = createCanvasDirtySignatureFactory();
    const element = { id: "base", version: 1, versionNonce: 11 };
    const file = {
      id: "file-1",
      dataURL: "data:image/png;base64,large-value",
      mimeType: "image/png",
      created: 1,
    };
    const first = signature({
      elements: [element],
      appState: { viewBackgroundColor: "#fff", scrollX: 0 },
      files: { "file-1": file },
    });
    const transientOnly = signature({
      elements: [element],
      appState: {
        viewBackgroundColor: "#fff",
        scrollX: 900,
        selectedElementIds: { base: true },
      },
      files: { "file-1": file },
    });
    const changed = signature({
      elements: [{ ...element, version: 2 }],
      appState: { viewBackgroundColor: "#fff", scrollX: 900 },
      files: { "file-1": file },
    });

    expect(transientOnly).toBe(first);
    expect(changed).not.toBe(first);
  });

  it("saves a newer observation after an in-flight acknowledgement", async () => {
    const firstSave = deferred<{ revision: number }>();
    const save = vi
      .fn()
      .mockImplementationOnce(() => firstSave.promise)
      .mockResolvedValueOnce({ revision: 3 });
    const coordinator = createCanvasPersistenceCoordinator({
      initial: { revision: 1, content: baseContent },
      save,
      fetch: vi.fn(),
      applyRemote: vi.fn(),
      onConflict: vi.fn(),
      onCommitted: vi.fn(),
    });
    const localA = {
      ...baseContent,
      elements: [...baseContent.elements, { id: "local-a", version: 1 }],
    };
    const localB = {
      ...baseContent,
      elements: [
        ...baseContent.elements,
        { id: "local-a", version: 1 },
        { id: "local-b", version: 1 },
      ],
    };

    const first = coordinator.observe(localA);
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const second = coordinator.observe(localB);
    firstSave.resolve({ revision: 2 });
    await Promise.all([first, second]);

    expect(save).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ expectedRevision: 1, content: localA }),
    );
    expect(save).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ expectedRevision: 2, content: localB }),
    );
    expect(coordinator.snapshot().base.revision).toBe(3);
  });

  it("confirms an ambiguous save by reading authoritative content", async () => {
    const onCommitted = vi.fn();
    const local = {
      ...baseContent,
      elements: [...baseContent.elements, { id: "local", version: 1 }],
    };
    const coordinator = createCanvasPersistenceCoordinator({
      initial: { revision: 1, content: baseContent },
      save: vi.fn().mockRejectedValue(new ApiTimeoutError()),
      fetch: vi.fn().mockResolvedValue({ revision: 2, content: local }),
      applyRemote: vi.fn(),
      onConflict: vi.fn(),
      onCommitted,
    });

    await coordinator.observe(local);

    expect(coordinator.snapshot().base).toMatchObject({
      revision: 2,
      content: local,
    });
    expect(onCommitted).toHaveBeenCalledWith(
      expect.objectContaining({ origin: "local", revision: 2 }),
    );
  });

  it("resolves a revision conflict by merging a remote append before retry", async () => {
    const local = {
      ...baseContent,
      elements: [...baseContent.elements, { id: "local", version: 1 }],
    };
    const remote = {
      ...baseContent,
      elements: [...baseContent.elements, { id: "job-1", version: 1 }],
    };
    const save = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiApplicationError("canvas_revision_conflict", "conflict", {
          status: 409,
        }),
      )
      .mockResolvedValueOnce({ revision: 3 });
    const applyRemote = vi.fn();
    const onConflict = vi.fn();
    const coordinator = createCanvasPersistenceCoordinator({
      initial: { revision: 1, content: baseContent },
      save,
      fetch: vi.fn().mockResolvedValue({ revision: 2, content: remote }),
      applyRemote,
      onConflict,
      onCommitted: vi.fn(),
    });

    await coordinator.observe(local);

    expect(applyRemote).toHaveBeenCalledWith({
      ...local,
      elements: [...local.elements, { id: "job-1", version: 1 }],
    });
    expect(save).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        expectedRevision: 2,
        content: {
          ...local,
          elements: [...local.elements, { id: "job-1", version: 1 }],
        },
      }),
    );
    expect(onConflict).not.toHaveBeenCalled();
    expect(coordinator.snapshot().base.revision).toBe(3);
  });

  it("retries the same pending content after a transport failure", async () => {
    const local = {
      ...baseContent,
      elements: [...baseContent.elements, { id: "local", version: 1 }],
    };
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce({ revision: 2 });
    const coordinator = createCanvasPersistenceCoordinator({
      initial: { revision: 1, content: baseContent },
      save,
      fetch: vi.fn(),
      applyRemote: vi.fn(),
      onConflict: vi.fn(),
      onCommitted: vi.fn(),
    });

    await expect(coordinator.observe(local)).rejects.toThrow(
      "network unavailable",
    );
    await expect(coordinator.observe(local)).resolves.toBeUndefined();

    expect(save).toHaveBeenCalledTimes(2);
    expect(coordinator.snapshot().base.revision).toBe(2);
  });

  it("stops and discards all persistence work after a REST 401", async () => {
    const local = {
      ...baseContent,
      elements: [...baseContent.elements, { id: "local", version: 1 }],
    };
    const save = vi.fn().mockRejectedValue(new ApiAuthError());
    const fetch = vi.fn();
    const coordinator = createCanvasPersistenceCoordinator({
      initial: { revision: 1, content: baseContent },
      save,
      fetch,
      applyRemote: vi.fn(),
      onConflict: vi.fn(),
      onCommitted: vi.fn(),
    });

    await expect(coordinator.observe(local)).rejects.toBeInstanceOf(
      ApiAuthError,
    );
    expect(coordinator.snapshot()).toMatchObject({
      stopped: true,
      pending: null,
      inFlight: null,
    });
    expect(coordinator.pendingUnload()).toBeNull();

    await expect(coordinator.observe(local)).resolves.toBeUndefined();
    await expect(coordinator.syncToRevision(2)).resolves.toBeUndefined();
    await expect(coordinator.reconcile()).resolves.toBeUndefined();
    expect(save).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

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
