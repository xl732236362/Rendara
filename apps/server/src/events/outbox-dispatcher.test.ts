import { describe, expect, it, vi } from "vitest";
import { dispatchOutboxBatch } from "./outbox-dispatcher.js";
import { CanvasEventBuffer } from "../ws/event-buffer.js";

const event = {
  event_id: "11111111-1111-4111-8111-111111111111",
  aggregate_type: "canvas",
  aggregate_id: "22222222-2222-4222-8222-222222222222",
  aggregate_version: 4,
  event_type: "canvas.updated",
  payload: { canvasId: "22222222-2222-4222-8222-222222222222" },
  occurred_at: "2026-08-18T00:00:00.000Z",
};

function setup(events: unknown[] = [event]) {
  return {
    workerId: "api-1",
    batchSize: 25,
    claim: vi.fn(async () => events),
    publish: vi.fn(async () => undefined),
    ack: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
  };
}

describe("domain outbox dispatcher", () => {
  it("publishes then acknowledges a bounded claim", async () => {
    const deps = setup();
    await expect(dispatchOutboxBatch(deps)).resolves.toEqual({
      claimed: 1,
      published: 1,
      failed: 0,
    });
    expect(deps.claim).toHaveBeenCalledWith(25, "api-1");
    expect(deps.publish.mock.invocationCallOrder[0]).toBeLessThan(
      deps.ack.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("records a sanitized failure without acknowledging", async () => {
    const deps = setup();
    deps.publish.mockRejectedValueOnce(new Error("socket secret"));
    await expect(dispatchOutboxBatch(deps)).resolves.toEqual({
      claimed: 1,
      published: 0,
      failed: 1,
    });
    expect(deps.ack).not.toHaveBeenCalled();
    expect(deps.fail).toHaveBeenCalledWith(
      event.event_id,
      "api-1",
      "event_publish_failed",
    );
  });

  it("allows redelivery after publish-before-ack crash", async () => {
    const publish = vi.fn(async () => undefined);
    const first = setup();
    first.publish = publish;
    first.ack.mockRejectedValueOnce(new Error("database unavailable"));
    await dispatchOutboxBatch(first);

    const retry = setup();
    retry.publish = publish;
    await dispatchOutboxBatch(retry);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("deduplicates a redelivered event by event id in the in-process inbox", () => {
    const buffer = new CanvasEventBuffer();
    const streamEvent = {
      type: "canvas.sync" as const,
      runId: event.event_id,
      timestamp: event.occurred_at,
    };
    expect(
      buffer.pushDomainEvent(event.aggregate_id, event.event_id, streamEvent),
    ).toBe(true);
    expect(
      buffer.pushDomainEvent(event.aggregate_id, event.event_id, streamEvent),
    ).toBe(false);
    expect(buffer.getAfter(event.aggregate_id)).toHaveLength(1);
  });
});
