// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiTimeoutError } from "../src/lib/api-client";

const apiMocks = vi.hoisted(() => ({
  fetchCanvas: vi.fn(),
  fetchJob: vi.fn(),
  getAssetUrl: vi.fn(),
  submitImageJob: vi.fn(),
}));
const fetchAsDataURLMock = vi.hoisted(() => vi.fn());

vi.mock("../src/lib/server-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/server-api")>()),
  ...apiMocks,
}));
vi.mock("../src/lib/canvas-elements", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/canvas-elements")>()),
  fetchAsDataURL: fetchAsDataURLMock,
}));

import { useCanvasImageGeneration } from "../src/hooks/use-canvas-image-generation";

const ids = {
  asset: "66666666-6666-4666-8666-666666666666",
  canvas: "33333333-3333-4333-8333-333333333333",
  job: "44444444-4444-4444-8444-444444444444",
  project: "22222222-2222-4222-8222-222222222222",
  user: "11111111-1111-4111-8111-111111111111",
};

function createHarness(status: "idle" | "generating" = "generating") {
  let elements: Record<string, any>[] = [
    {
      id: "generator-1",
      type: "rectangle",
      x: 10,
      y: 20,
      width: 300,
      height: 200,
      angle: 0.5,
      groupIds: ["group-1"],
      frameId: "frame-1",
      isDeleted: false,
      customData: {
        type: "image-generator",
        status,
        prompt: "draw",
        model: "image/model",
        aspectRatio: "1:1",
        quality: "hd",
        idempotencyKey: "attempt-1",
      },
    },
  ];
  const listeners = new Set<() => void>();
  const excalidrawApi = {
    getSceneElements: () => elements,
    getFiles: () => ({}),
    getAppState: () => ({}),
    addFiles: vi.fn(),
    updateScene: vi.fn(({ elements: next }) => {
      elements = next;
      listeners.forEach((listener) => listener());
    }),
    onChange: vi.fn((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };
  const durableMutation = vi.fn(async (mutate) => {
    elements = mutate(elements);
    return { kind: "committed" as const };
  });
  return { excalidrawApi, durableMutation, getElements: () => elements };
}

function succeededJob() {
  return {
    job: {
      id: ids.job,
      workspace_id: "77777777-7777-4777-8777-777777777777",
      project_id: ids.project,
      canvas_id: ids.canvas,
      session_id: null,
      thread_id: null,
      queue_name: "image_generation",
      job_type: "image_generation",
      status: "succeeded",
      payload: {},
      result: {
        asset_id: ids.asset,
        mime_type: "image/png",
        width: 1024,
        height: 1024,
      },
      error_code: null,
      error_message: null,
      attempt_count: 1,
      max_attempts: 3,
      transition_version: 2,
      lease_token: null,
      lease_owner: null,
      lease_expires_at: null,
      pgmq_message_id: null,
      credits_transaction_id: null,
      credits_cost: 1,
      created_by: ids.user,
      created_at: "2026-08-18T00:00:00.000Z",
      updated_at: "2026-08-18T00:00:00.000Z",
      started_at: null,
      completed_at: "2026-08-18T00:00:01.000Z",
      failed_at: null,
      canceled_at: null,
    },
  };
}

describe("useCanvasImageGeneration", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("retries an ambiguous submission with the same idempotency key", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    apiMocks.submitImageJob
      .mockRejectedValueOnce(new ApiTimeoutError())
      .mockResolvedValueOnce({
        job: { ...succeededJob().job, status: "queued" },
      });
    apiMocks.fetchJob.mockReturnValue(new Promise(() => undefined));
    const { unmount } = renderHook(() =>
      useCanvasImageGeneration({
        accessToken: "token",
        userId: ids.user,
        projectId: ids.project,
        canvasId: ids.canvas,
        excalidrawApi: harness.excalidrawApi,
        durableMutation: harness.durableMutation,
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(apiMocks.submitImageJob).toHaveBeenCalledOnce();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(apiMocks.submitImageJob).toHaveBeenCalledTimes(2);
    expect(
      new Set(
        apiMocks.submitImageJob.mock.calls.map(
          (call) => call[1].idempotency_key,
        ),
      ),
    ).toEqual(new Set(["attempt-1"]));
    unmount();
  });

  it("does not submit until the initial attempt save is acknowledged", async () => {
    const harness = createHarness("idle");
    let acknowledge!: () => void;
    const durableMutation = vi.fn(async (mutate) => {
      harness.excalidrawApi.updateScene({
        elements: mutate(harness.getElements()),
      });
      return new Promise<{ kind: "committed" }>((resolve) => {
        acknowledge = () => resolve({ kind: "committed" });
      });
    });
    const { result } = renderHook(() =>
      useCanvasImageGeneration({
        accessToken: "token",
        userId: ids.user,
        projectId: ids.project,
        canvasId: ids.canvas,
        excalidrawApi: harness.excalidrawApi,
        durableMutation,
      }),
    );
    let start!: Promise<void>;
    act(() => {
      start = result.current.startAttempt("generator-1", {
        prompt: "draw",
        model: "image/model",
        aspectRatio: "1:1",
        quality: "hd",
        referenceAssetIds: [],
      });
    });
    await Promise.resolve();
    expect(apiMocks.submitImageJob).not.toHaveBeenCalled();

    await act(async () => {
      acknowledge();
      await start;
    });
    await waitFor(() => expect(apiMocks.submitImageJob).toHaveBeenCalledOnce());
  });

  it("keeps one non-editable attempt key while an ambiguous save is unconfirmed", async () => {
    const harness = createHarness("idle");
    const durableMutation = vi.fn(async (mutate) => {
      const previous = harness.getElements();
      harness.excalidrawApi.updateScene({ elements: mutate(previous) });
      harness.excalidrawApi.updateScene({ elements: previous });
      return { kind: "ambiguous" as const };
    });
    apiMocks.fetchCanvas.mockRejectedValue(new Error("offline"));
    const { result, unmount } = renderHook(() =>
      useCanvasImageGeneration({
        accessToken: "token",
        userId: ids.user,
        projectId: ids.project,
        canvasId: ids.canvas,
        excalidrawApi: harness.excalidrawApi,
        durableMutation,
      }),
    );
    const fields = {
      prompt: "draw",
      model: "image/model",
      aspectRatio: "1:1",
      quality: "hd",
      referenceAssetIds: [],
    };

    await act(async () => {
      await result.current.startAttempt("generator-1", fields);
      await result.current.startAttempt("generator-1", fields);
    });

    const attemptKeys = harness
      .getElements()
      .map((element) => element.customData?.idempotencyKey)
      .filter(Boolean);
    expect(new Set(attemptKeys).size).toBe(1);
    expect(harness.getElements()[0]?.customData.status).toBe("generating");
    expect(durableMutation).toHaveBeenCalledOnce();
    expect(apiMocks.submitImageJob).not.toHaveBeenCalled();
    unmount();
  });

  it("replays a persisted attempt and replaces it from an unselected canvas scan", async () => {
    const harness = createHarness();
    apiMocks.submitImageJob.mockResolvedValue({
      job: { ...succeededJob().job, status: "queued" },
    });
    apiMocks.fetchJob.mockResolvedValue(succeededJob());
    apiMocks.getAssetUrl.mockResolvedValue({ url: "https://asset.test/a.png" });
    fetchAsDataURLMock.mockResolvedValue("data:image/png;base64,aW1hZ2U=");

    renderHook(() =>
      useCanvasImageGeneration({
        accessToken: "token",
        userId: ids.user,
        projectId: ids.project,
        canvasId: ids.canvas,
        excalidrawApi: harness.excalidrawApi,
        durableMutation: harness.durableMutation,
      }),
    );

    await waitFor(() =>
      expect(apiMocks.fetchJob).toHaveBeenCalledWith("token", ids.job),
    );
    expect(apiMocks.submitImageJob).toHaveBeenCalledWith(
      "token",
      expect.objectContaining({
        idempotency_key: "attempt-1",
        project_id: ids.project,
        canvas_id: ids.canvas,
      }),
    );
    await waitFor(() => {
      expect(
        harness.getElements().some((element) => element.type === "image"),
      ).toBe(true);
    });
    const image = harness
      .getElements()
      .find((element) => element.type === "image");
    expect(image).toMatchObject({
      x: 10,
      y: 20,
      width: 300,
      height: 200,
      angle: 0.5,
      groupIds: ["group-1"],
      frameId: "frame-1",
    });
    expect(harness.excalidrawApi.addFiles).toHaveBeenCalledWith([
      expect.objectContaining({ assetId: ids.asset }),
    ]);
  });

  it("does not recreate a deleted placeholder when completion arrives", async () => {
    const harness = createHarness();
    let resolveJob!: (value: ReturnType<typeof succeededJob>) => void;
    apiMocks.submitImageJob.mockResolvedValue({
      job: { ...succeededJob().job, status: "queued" },
    });
    apiMocks.fetchJob.mockReturnValue(
      new Promise((resolve) => {
        resolveJob = resolve;
      }),
    );

    const { unmount } = renderHook(() =>
      useCanvasImageGeneration({
        accessToken: "token",
        userId: ids.user,
        projectId: ids.project,
        canvasId: ids.canvas,
        excalidrawApi: harness.excalidrawApi,
        durableMutation: harness.durableMutation,
      }),
    );
    await waitFor(() => expect(apiMocks.fetchJob).toHaveBeenCalled());
    await act(async () => {
      await harness.durableMutation((elements: Record<string, any>[]) =>
        elements.map((element) => ({ ...element, isDeleted: true })),
      );
      resolveJob(succeededJob());
    });
    await Promise.resolve();

    expect(
      harness.getElements().some((element) => element.type === "image"),
    ).toBe(false);
    unmount();
  });
});
