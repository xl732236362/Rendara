import { describe, expect, it, vi } from "vitest";
import { CanvasEventBuffer } from "../ws/event-buffer.js";
import { createDomainEventPublisher } from "./domain-event-publisher.js";
import { dispatchOutboxBatch } from "./outbox-dispatcher.js";

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
  it("acknowledges a valid Agent acceptance lifecycle event", async () => {
    const publish = createDomainEventPublisher({
      appendCanvasEvent: vi.fn(),
      pushCanvas: vi.fn(),
      sendToUser: vi.fn(),
    });

    await expect(
      publish({
        ...event,
        aggregate_type: "agent_run",
        event_type: "agent.run.accepted",
        payload: { attemptId: "attempt-1", runId: event.aggregate_id },
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects unknown Agent lifecycle events", async () => {
    const publish = createDomainEventPublisher({
      appendCanvasEvent: vi.fn(),
      pushCanvas: vi.fn(),
      sendToUser: vi.fn(),
    });

    await expect(
      publish({
        ...event,
        aggregate_type: "agent_run",
        event_type: "agent.run.unknown",
        payload: { attemptId: "attempt-1", runId: event.aggregate_id },
      }),
    ).rejects.toMatchObject({ code: "invalid_agent_run_event" });
  });

  it("publishes generation events to the owning user instead of silently acknowledging", async () => {
    const sendToUser = vi.fn(() => true);
    const publish = createDomainEventPublisher({
      appendCanvasEvent: vi.fn(),
      pushCanvas: vi.fn(),
      sendToUser,
    });
    await publish({
      ...event,
      aggregate_type: "generation_job",
      event_type: "generation.job.succeeded",
      payload: { jobId: event.aggregate_id, userId: "user-1" },
    });
    expect(sendToUser).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({
        type: "domain.event",
        eventId: event.event_id,
        eventType: "generation.job.succeeded",
      }),
    );
  });

  it("rejects an offline generation delivery so the outbox remains pending", async () => {
    const publish = createDomainEventPublisher({
      appendCanvasEvent: vi.fn(),
      pushCanvas: vi.fn(),
      sendToUser: vi.fn(() => false),
    });
    await expect(
      publish({
        ...event,
        aggregate_type: "generation_job",
        payload: { jobId: event.aggregate_id, userId: "user-1" },
      }),
    ).rejects.toMatchObject({ code: "generation_event_not_delivered" });
  });

  it("rejects unsupported aggregate types so they are retried, not acknowledged", async () => {
    const publish = createDomainEventPublisher({
      appendCanvasEvent: vi.fn(),
      pushCanvas: vi.fn(),
      sendToUser: vi.fn(),
    });
    await expect(
      publish({ ...event, aggregate_type: "unknown" }),
    ).rejects.toMatchObject({ code: "unsupported_outbox_aggregate" });
  });
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
      eventId: event.event_id,
      canvasId: event.aggregate_id,
      revision: event.aggregate_version,
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
