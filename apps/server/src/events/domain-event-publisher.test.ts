import { describe, expect, it, vi } from "vitest";

import { createDomainEventPublisher } from "./domain-event-publisher.js";

const recovered = {
  event_id: "11111111-1111-4111-8111-111111111111",
  aggregate_type: "agent_run",
  aggregate_id: "22222222-2222-4222-8222-222222222222",
  aggregate_version: 4,
  event_type: "agent.run.failed",
  occurred_at: "2026-08-20T00:00:00.000Z",
  payload: {
    runId: "22222222-2222-4222-8222-222222222222",
    attemptId: "33333333-3333-4333-8333-333333333333",
    userId: "44444444-4444-4444-8444-444444444444",
    canvasId: "55555555-5555-4555-8555-555555555555",
    error: {
      code: "agent_attempt_lease_expired",
      message: "The Agent run stopped before completion.",
    },
  },
};

describe("Agent run domain event publishing", () => {
  it("persists a canvas event before local fan-out with its durable cursor", async () => {
    const appendCanvasEvent = vi.fn(async () => ({ seq: 12, inserted: true }));
    const pushCanvas = vi.fn();
    const publish = createDomainEventPublisher({
      appendCanvasEvent,
      pushCanvas,
      sendToUser: vi.fn(() => true),
    });

    await publish({
      event_id: "11111111-1111-4111-8111-111111111112",
      aggregate_type: "canvas",
      aggregate_id: "55555555-5555-4555-8555-555555555555",
      aggregate_version: 3,
      event_type: "canvas.updated",
      occurred_at: "2026-08-21T00:00:00.000Z",
      payload: {
        canvasId: "55555555-5555-4555-8555-555555555555",
        revision: 3,
      },
    });

    expect(appendCanvasEvent.mock.invocationCallOrder[0]).toBeLessThan(
      pushCanvas.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(pushCanvas).toHaveBeenCalledWith(
      "55555555-5555-4555-8555-555555555555",
      expect.objectContaining({
        eventId: "11111111-1111-4111-8111-111111111112",
      }),
      12,
    );
  });

  it("does not repeat local fan-out when durable append reports a replay", async () => {
    const pushCanvas = vi.fn();
    const publish = createDomainEventPublisher({
      appendCanvasEvent: vi.fn(async () => ({ seq: 12, inserted: false })),
      pushCanvas,
      sendToUser: vi.fn(() => true),
    });

    await publish({
      event_id: "11111111-1111-4111-8111-111111111112",
      aggregate_type: "canvas",
      aggregate_id: "55555555-5555-4555-8555-555555555555",
      aggregate_version: 3,
      event_type: "canvas.updated",
      occurred_at: "2026-08-21T00:00:00.000Z",
      payload: {
        canvasId: "55555555-5555-4555-8555-555555555555",
        revision: 3,
      },
    });

    expect(pushCanvas).not.toHaveBeenCalled();
  });

  it("validates and delivers a recovered terminal failure to its owner", async () => {
    const sendToUser = vi.fn(() => true);
    const publish = createDomainEventPublisher({
      appendCanvasEvent: vi.fn(),
      pushCanvas: vi.fn(),
      sendToUser,
    });

    await publish(recovered);

    expect(sendToUser).toHaveBeenCalledWith(
      recovered.payload.userId,
      expect.objectContaining({
        eventId: recovered.event_id,
        eventType: "agent.run.failed",
        payload: recovered.payload,
        type: "domain.event",
      }),
    );
  });

  it("rejects malformed or offline recovered failures for outbox retry", async () => {
    const publish = createDomainEventPublisher({
      appendCanvasEvent: vi.fn(),
      pushCanvas: vi.fn(),
      sendToUser: vi.fn(() => false),
    });

    await expect(publish(recovered)).rejects.toMatchObject({
      code: "agent_run_event_not_delivered",
    });
    await expect(
      publish({
        ...recovered,
        payload: {
          ...recovered.payload,
          error: { code: "database_secret", message: "leaked" },
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_agent_run_event" });
  });
});
