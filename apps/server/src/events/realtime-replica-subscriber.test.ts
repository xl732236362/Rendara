import { describe, expect, it, vi } from "vitest";

import { createRealtimeReplicaSubscriber } from "./realtime-replica-subscriber.js";

describe("realtime replica subscriber", () => {
  it("reads a notified event from durable storage before local fan-out", async () => {
    const readAfter = vi.fn(async () => ({
      status: "replayed" as const,
      earliestSeq: 1,
      latestSeq: 3,
      latestRevision: 3,
      events: [
        {
          eventId: "10000000-0000-4000-8000-000000000003",
          canvasId: "10000000-0000-4000-8000-000000000001",
          seq: 3,
          eventType: "canvas.sync",
          payload: {
            type: "canvas.sync",
            eventId: "10000000-0000-4000-8000-000000000003",
            canvasId: "10000000-0000-4000-8000-000000000001",
            revision: 3,
            timestamp: "2026-08-21T00:00:00.000Z",
          },
          occurredAt: "2026-08-21T00:00:00.000Z",
        },
      ],
    }));
    const pushCanvas = vi.fn();
    const subscriber = createRealtimeReplicaSubscriber({
      store: { readAfter } as never,
      pushCanvas,
    });

    await subscriber.handleNotification({
      canvasId: "10000000-0000-4000-8000-000000000001",
      eventId: "10000000-0000-4000-8000-000000000003",
      seq: 3,
    });

    expect(readAfter).toHaveBeenCalledWith(
      "10000000-0000-4000-8000-000000000001",
      2,
      1,
    );
    expect(pushCanvas).toHaveBeenCalledWith(
      "10000000-0000-4000-8000-000000000001",
      expect.objectContaining({ revision: 3 }),
      3,
    );
  });

  it("deduplicates repeated notifications on one replica", async () => {
    const readAfter = vi.fn(async () => ({
      status: "replayed" as const,
      earliestSeq: 1,
      latestSeq: 3,
      latestRevision: 3,
      events: [
        {
          eventId: "10000000-0000-4000-8000-000000000003",
          canvasId: "10000000-0000-4000-8000-000000000001",
          seq: 3,
          eventType: "canvas.sync",
          payload: {
            type: "canvas.sync",
            eventId: "10000000-0000-4000-8000-000000000003",
            canvasId: "10000000-0000-4000-8000-000000000001",
            revision: 3,
            timestamp: "2026-08-21T00:00:00.000Z",
          },
          occurredAt: "2026-08-21T00:00:00.000Z",
        },
      ],
    }));
    const subscriber = createRealtimeReplicaSubscriber({
      store: { readAfter } as never,
      pushCanvas: vi.fn(),
    });
    const notification = {
      canvasId: "10000000-0000-4000-8000-000000000001",
      eventId: "10000000-0000-4000-8000-000000000003",
      seq: 3,
    };

    await subscriber.handleNotification(notification);
    await subscriber.handleNotification(notification);

    expect(readAfter).toHaveBeenCalledOnce();
  });

  it("ignores notification echo after local delivery", async () => {
    const readAfter = vi.fn();
    const subscriber = createRealtimeReplicaSubscriber({
      store: { readAfter } as never,
      pushCanvas: vi.fn(),
    });
    subscriber.markDelivered("10000000-0000-4000-8000-000000000001", 3);

    await subscriber.handleNotification({
      canvasId: "10000000-0000-4000-8000-000000000001",
      eventId: "10000000-0000-4000-8000-000000000003",
      seq: 3,
    });

    expect(readAfter).not.toHaveBeenCalled();
  });

  it("establishes a baseline without replaying history for a newly bound canvas", async () => {
    const readAfter = vi.fn(async () => ({
      status: "replayed" as const,
      earliestSeq: 1,
      latestSeq: 8,
      latestRevision: 8,
      events: [{ seq: 1 }],
    }));
    const pushCanvas = vi.fn();
    const subscriber = createRealtimeReplicaSubscriber({
      store: { readAfter } as never,
      pushCanvas,
    });

    await subscriber.reconcile(["canvas-1"]);

    expect(readAfter).toHaveBeenCalledWith("canvas-1", 0, 1);
    expect(pushCanvas).not.toHaveBeenCalled();
  });

  it("recovers ordered events after a notification is lost", async () => {
    const event = (seq: number) => ({
      eventId: `10000000-0000-4000-8000-00000000000${seq}`,
      canvasId: "10000000-0000-4000-8000-000000000001",
      seq,
      eventType: "canvas.sync",
      payload: {
        type: "canvas.sync",
        eventId: `10000000-0000-4000-8000-00000000000${seq}`,
        canvasId: "10000000-0000-4000-8000-000000000001",
        revision: seq,
        timestamp: "2026-08-21T00:00:00.000Z",
      },
      occurredAt: "2026-08-21T00:00:00.000Z",
    });
    const readAfter = vi.fn(async () => ({
      status: "replayed" as const,
      earliestSeq: 1,
      latestSeq: 3,
      latestRevision: 3,
      events: [event(2), event(3)],
    }));
    const pushCanvas = vi.fn();
    const subscriber = createRealtimeReplicaSubscriber({
      store: { readAfter } as never,
      pushCanvas,
    });
    subscriber.markDelivered("10000000-0000-4000-8000-000000000001", 1);

    await subscriber.reconcile(["10000000-0000-4000-8000-000000000001"]);

    expect(readAfter).toHaveBeenCalledWith(
      "10000000-0000-4000-8000-000000000001",
      1,
      100,
    );
    expect(pushCanvas.mock.calls.map((call) => call[2])).toEqual([2, 3]);
  });
});
