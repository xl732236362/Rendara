import { describe, expect, it, vi } from "vitest";

import { createPostgresRealtimeEventStore } from "./realtime-event-store.js";

describe("Postgres realtime event store", () => {
  it("returns the durable cursor assigned to an idempotent append", async () => {
    const rpc = vi.fn(async () => ({
      data: [{ canvas_seq: 7, inserted: false }],
      error: null,
    }));
    const store = createPostgresRealtimeEventStore({ rpc });

    await expect(
      store.append({
        eventId: "10000000-0000-4000-8000-000000000001",
        canvasId: "10000000-0000-4000-8000-000000000002",
        eventType: "canvas.sync",
        payload: { revision: 7 },
        occurredAt: "2026-08-21T00:00:00.000Z",
      }),
    ).resolves.toEqual({ seq: 7, inserted: false });
  });

  it("returns cursor_gap without reading events from a truncated range", async () => {
    const rpc = vi.fn().mockResolvedValueOnce({
      data: [
        { earliest_seq: 10, latest_seq: 15, latest_revision: 15, gap: true },
      ],
      error: null,
    });
    const store = createPostgresRealtimeEventStore({ rpc });

    await expect(
      store.readAfter("10000000-0000-4000-8000-000000000002", 3, 100),
    ).resolves.toEqual({
      status: "cursor_gap",
      earliestSeq: 10,
      latestSeq: 15,
      latestRevision: 15,
      events: [],
    });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("returns ordered durable events for a retained cursor", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({
        data: [
          { earliest_seq: 4, latest_seq: 5, latest_revision: 5, gap: false },
        ],
        error: null,
      })
      .mockResolvedValueOnce({
        data: [
          {
            event_id: "10000000-0000-4000-8000-000000000004",
            canvas_id: "10000000-0000-4000-8000-000000000002",
            canvas_seq: 4,
            event_type: "canvas.sync",
            payload: { revision: 4 },
            occurred_at: "2026-08-21T00:00:00.000Z",
          },
          {
            event_id: "10000000-0000-4000-8000-000000000005",
            canvas_id: "10000000-0000-4000-8000-000000000002",
            canvas_seq: 5,
            event_type: "canvas.sync",
            payload: { revision: 5 },
            occurred_at: "2026-08-21T00:00:01.000Z",
          },
        ],
        error: null,
      });
    const store = createPostgresRealtimeEventStore({ rpc });

    const replay = await store.readAfter(
      "10000000-0000-4000-8000-000000000002",
      3,
      100,
    );

    expect(replay.status).toBe("replayed");
    expect(replay.events.map((event) => event.seq)).toEqual([4, 5]);
  });

  it("maps database failures to a stable private error code", async () => {
    const store = createPostgresRealtimeEventStore({
      rpc: vi.fn(async () => ({ data: null, error: { message: "secret" } })),
    });

    await expect(
      store.readAfter("10000000-0000-4000-8000-000000000002", 0, 100),
    ).rejects.toMatchObject({ code: "realtime_store_unavailable" });
  });
});
