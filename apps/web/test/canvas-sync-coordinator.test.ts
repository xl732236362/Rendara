import { describe, expect, it, vi } from "vitest";

import { createCanvasSyncCoordinator } from "../src/lib/canvas-sync-coordinator";

describe("canvas sync coordinator", () => {
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
