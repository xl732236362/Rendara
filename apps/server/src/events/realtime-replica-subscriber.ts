import { type StreamEvent, streamEventSchema } from "@loomic/shared";
import type { RealtimeEventStore } from "./realtime-event-store.js";

export type RealtimeNotification = {
  canvasId: string;
  eventId: string;
  seq: number;
};

export type RealtimeReplicaSubscriber = {
  handleNotification(notification: RealtimeNotification): Promise<void>;
  markDelivered(canvasId: string, seq: number): void;
  reconcile(canvasIds: readonly string[]): Promise<void>;
};

export function createRealtimeReplicaSubscriber(options: {
  store: Pick<RealtimeEventStore, "readAfter">;
  pushCanvas(canvasId: string, event: StreamEvent, seq: number): void;
  onGap?(canvasId: string, latestSeq: number): void;
}): RealtimeReplicaSubscriber {
  const deliveredSeq = new Map<string, number>();

  return {
    markDelivered(canvasId, seq) {
      deliveredSeq.set(
        canvasId,
        Math.max(deliveredSeq.get(canvasId) ?? 0, seq),
      );
    },
    async reconcile(canvasIds) {
      for (const canvasId of canvasIds) {
        const knownSeq = deliveredSeq.get(canvasId);
        if (knownSeq === undefined) {
          const baseline = await options.store.readAfter(canvasId, 0, 1);
          deliveredSeq.set(canvasId, baseline.latestSeq);
          continue;
        }

        const replay = await options.store.readAfter(canvasId, knownSeq, 100);
        if (replay.status === "cursor_gap") {
          deliveredSeq.set(canvasId, replay.latestSeq);
          options.onGap?.(canvasId, replay.latestSeq);
          continue;
        }
        for (const entry of replay.events) {
          if (entry.seq <= (deliveredSeq.get(canvasId) ?? 0)) continue;
          options.pushCanvas(
            canvasId,
            streamEventSchema.parse(entry.payload),
            entry.seq,
          );
          deliveredSeq.set(canvasId, entry.seq);
        }
      }
    },
    async handleNotification(notification) {
      const knownSeq = deliveredSeq.get(notification.canvasId) ?? 0;
      if (knownSeq >= notification.seq) return;

      // Reserve the cursor before awaiting so concurrent duplicate NOTIFY
      // callbacks cannot perform duplicate reads/fan-out on this replica.
      deliveredSeq.set(notification.canvasId, notification.seq);
      try {
        const replay = await options.store.readAfter(
          notification.canvasId,
          notification.seq - 1,
          1,
        );
        const event = replay.events[0];
        if (
          !event ||
          event.seq !== notification.seq ||
          event.eventId !== notification.eventId
        ) {
          throw Object.assign(
            new Error("Realtime notification is not readable."),
            {
              code: "realtime_notification_unavailable",
            },
          );
        }
        options.pushCanvas(
          notification.canvasId,
          streamEventSchema.parse(event.payload),
          event.seq,
        );
      } catch (error) {
        deliveredSeq.set(notification.canvasId, knownSeq);
        throw error;
      }
    },
  };
}
