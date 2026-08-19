import { describe, expect, it, vi } from "vitest";

import { createCanvasSyncCoordinator } from "../src/lib/canvas-sync-coordinator";
import {
  createCanvasPersistenceCoordinator,
  mergeAppendOnlyRemoteContent,
} from "../src/lib/canvas-persistence";

const base = {
  elements: [{ id: "base", version: 1 }],
  appState: { viewBackgroundColor: "#fff", gridModeEnabled: false },
  files: {},
};

describe("canvas sync coordinator", () => {
  it("merges remote-only generated elements with unsaved local edits", () => {
    const local = {
      ...base,
      elements: [{ id: "base", version: 2 }, { id: "local", version: 1 }],
    };
    const remote = {
      ...base,
      elements: [...base.elements, { id: "job-1", version: 1 }],
      files: {
        "job-1-file": {
          id: "job-1-file",
          assetId: "11111111-1111-4111-8111-111111111111",
          mimeType: "image/png",
          created: 1,
        },
      },
    };

    expect(mergeAppendOnlyRemoteContent({ base, local, remote })).toEqual({
      kind: "merged",
      content: {
        ...local,
        elements: [...local.elements, { id: "job-1", version: 1 }],
        files: remote.files,
      },
    });
  });

  it("rejects a remote change to an existing base element", () => {
    expect(
      mergeAppendOnlyRemoteContent({
        base,
        local: {
          ...base,
          elements: [{ id: "base", version: 2 }],
        },
        remote: {
          ...base,
          elements: [{ id: "base", version: 3 }],
        },
      }),
    ).toMatchObject({ kind: "conflict", reason: "remote_changed_base" });
  });

  it("serializes sync behind the save that produced the preceding revision", async () => {
    let releaseSave!: () => void;
    const applyRemote = vi.fn();
    const remote = {
      ...base,
      elements: [
        ...base.elements,
        { id: "local", version: 1 },
        { id: "job-1", version: 1 },
      ],
    };
    const coordinator = createCanvasPersistenceCoordinator({
      initial: { revision: 1, content: base },
      save: vi.fn(
        () =>
          new Promise<{ revision: number }>((resolve) => {
            releaseSave = () => resolve({ revision: 2 });
          }),
      ),
      fetch: vi.fn().mockResolvedValue({ revision: 3, content: remote }),
      applyRemote,
      onConflict: vi.fn(),
      onCommitted: vi.fn(),
    });
    const local = {
      ...base,
      elements: [...base.elements, { id: "local", version: 1 }],
    };

    const save = coordinator.observe(local);
    await vi.waitFor(() => expect(releaseSave).toBeTypeOf("function"));
    const sync = coordinator.syncToRevision(3);
    expect(applyRemote).not.toHaveBeenCalled();
    releaseSave();
    await Promise.all([save, sync]);

    expect(applyRemote).toHaveBeenCalledWith(
      expect.objectContaining({
        elements: [
          { id: "base", version: 1 },
          { id: "local", version: 1 },
          { id: "job-1", version: 1 },
        ],
      }),
    );
    expect(coordinator.snapshot().base.revision).toBe(3);
  });

  it("coalesces concurrent revisions into one snapshot fetch", async () => {
    let release!: () => void;
    const fetchAndApply = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          release = () => resolve(3);
        }),
    );
    const coordinator = createCanvasSyncCoordinator({
      appliedRevision: 1,
      fetchAndApply,
    });

    const first = coordinator.request({ eventId: "event-2", revision: 2 });
    const second = coordinator.request({ eventId: "event-3", revision: 3 });
    release();
    await Promise.all([first, second]);

    expect(fetchAndApply).toHaveBeenCalledTimes(1);
    expect(coordinator.appliedRevision()).toBe(3);
  });

  it("ignores replayed event ids and stale revisions", async () => {
    const fetchAndApply = vi.fn(async () => 2);
    const coordinator = createCanvasSyncCoordinator({
      appliedRevision: 1,
      fetchAndApply,
    });

    await coordinator.request({ eventId: "event-2", revision: 2 });
    await coordinator.request({ eventId: "event-2", revision: 2 });
    await coordinator.request({ eventId: "event-old", revision: 1 });

    expect(fetchAndApply).toHaveBeenCalledTimes(1);
  });

  it("allows the same event to retry after a temporary fetch failure", async () => {
    const fetchAndApply = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce(2);
    const coordinator = createCanvasSyncCoordinator({
      appliedRevision: 1,
      fetchAndApply,
    });

    await expect(
      coordinator.request({ eventId: "event-2", revision: 2 }),
    ).rejects.toThrow("temporary");
    await expect(
      coordinator.request({ eventId: "event-2", revision: 2 }),
    ).resolves.toBeUndefined();

    expect(fetchAndApply).toHaveBeenCalledTimes(2);
  });
});
