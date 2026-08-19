import type { StreamEvent } from "@loomic/shared";

import type { OutboxEvent } from "./outbox-dispatcher.js";

type PublisherPorts = {
  rememberCanvasEvent(
    canvasId: string,
    eventId: string,
    event: StreamEvent,
  ): boolean;
  pushCanvas(canvasId: string, event: StreamEvent): void;
  sendToUser(userId: string, message: Record<string, unknown>): boolean;
};

export function createDomainEventPublisher(ports: PublisherPorts) {
  return async (event: OutboxEvent): Promise<void> => {
    if (event.aggregate_type === "canvas") {
      const streamEvent = {
        type: "canvas.sync" as const,
        runId: event.event_id,
        timestamp: event.occurred_at,
      };
      if (
        ports.rememberCanvasEvent(
          event.aggregate_id,
          event.event_id,
          streamEvent,
        )
      ) {
        ports.pushCanvas(event.aggregate_id, streamEvent);
      }
      return;
    }

    if (event.aggregate_type === "generation_job") {
      const userId = event.payload.userId;
      if (typeof userId !== "string" || userId.length === 0) {
        throw codedError("invalid_generation_event");
      }
      const delivered = ports.sendToUser(userId, {
        type: "domain.event",
        eventId: event.event_id,
        eventType: event.event_type,
        aggregateId: event.aggregate_id,
        aggregateVersion: event.aggregate_version,
        payload: event.payload,
        occurredAt: event.occurred_at,
      });
      if (!delivered) throw codedError("generation_event_not_delivered");
      return;
    }

    if (event.aggregate_type === "agent_run") {
      if (
        event.event_type !== "agent.run.accepted" ||
        event.payload.runId !== event.aggregate_id ||
        typeof event.payload.attemptId !== "string" ||
        event.payload.attemptId.length === 0
      ) {
        throw codedError("invalid_agent_run_event");
      }
      return;
    }

    throw codedError("unsupported_outbox_aggregate");
  };
}

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
