import type { StreamEvent } from "@loomic/shared";
import { z } from "zod";

import type { OutboxEvent } from "./outbox-dispatcher.js";

type PublisherPorts = {
  appendCanvasEvent(input: {
    eventId: string;
    canvasId: string;
    eventType: string;
    payload: Record<string, unknown>;
    occurredAt: string;
  }): Promise<{ seq: number; inserted: boolean }>;
  pushCanvas(canvasId: string, event: StreamEvent, seq?: number): void;
  markCanvasDelivered?(canvasId: string, seq: number): void;
  sendToUser(userId: string, message: Record<string, unknown>): boolean;
};

export function createDomainEventPublisher(ports: PublisherPorts) {
  return async (event: OutboxEvent): Promise<void> => {
    if (event.aggregate_type === "canvas") {
      if (
        event.event_type !== "canvas.updated" ||
        event.payload.canvasId !== event.aggregate_id ||
        event.payload.revision !== event.aggregate_version ||
        !Number.isSafeInteger(event.aggregate_version) ||
        event.aggregate_version < 1
      ) {
        throw codedError("invalid_canvas_event");
      }
      const streamEvent = {
        type: "canvas.sync" as const,
        eventId: event.event_id,
        canvasId: event.aggregate_id,
        revision: event.aggregate_version,
        timestamp: event.occurred_at,
      };
      const stored = await ports.appendCanvasEvent({
        eventId: event.event_id,
        canvasId: event.aggregate_id,
        eventType: streamEvent.type,
        payload: streamEvent,
        occurredAt: event.occurred_at,
      });
      if (stored.inserted) {
        ports.pushCanvas(event.aggregate_id, streamEvent, stored.seq);
        ports.markCanvasDelivered?.(event.aggregate_id, stored.seq);
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
      if (event.event_type === "agent.run.failed") {
        const parsed = recoveredAgentRunFailureSchema.safeParse(event.payload);
        if (!parsed.success || parsed.data.runId !== event.aggregate_id) {
          throw codedError("invalid_agent_run_event");
        }
        const delivered = ports.sendToUser(parsed.data.userId, {
          type: "domain.event",
          eventId: event.event_id,
          eventType: event.event_type,
          aggregateId: event.aggregate_id,
          aggregateVersion: event.aggregate_version,
          payload: parsed.data,
          occurredAt: event.occurred_at,
        });
        if (!delivered) throw codedError("agent_run_event_not_delivered");
        return;
      }
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

const recoveredAgentRunFailureSchema = z
  .object({
    runId: z.string().uuid(),
    attemptId: z.string().uuid(),
    userId: z.string().uuid(),
    canvasId: z.string().uuid(),
    error: z
      .object({
        code: z.literal("agent_attempt_lease_expired"),
        message: z.literal("The Agent run stopped before completion."),
      })
      .strict(),
  })
  .strict();

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
