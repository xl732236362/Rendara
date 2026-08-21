import { Client, type Notification } from "pg";
import { z } from "zod";
import type {
  RealtimeNotification,
  RealtimeReplicaSubscriber,
} from "./realtime-replica-subscriber.js";

const CHANNEL = "loomic_realtime_canvas";
const notificationSchema = z.object({
  canvasId: z.string().uuid(),
  eventId: z.string().uuid(),
  seq: z.number().int().positive().safe(),
});

export function parseRealtimeNotification(
  notification: Pick<Notification, "channel" | "payload">,
): RealtimeNotification | null {
  if (notification.channel !== CHANNEL || !notification.payload) return null;
  try {
    const parsed = notificationSchema.safeParse(
      JSON.parse(notification.payload),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function startPostgresRealtimeListener(options: {
  databaseUrl: string;
  signal: AbortSignal;
  subscriber: RealtimeReplicaSubscriber;
  onError?(error: unknown): void;
  onConnected?(): void;
  onDisconnected?(): void;
  onNotification?(): void;
}): Promise<void> {
  while (!options.signal.aborted) {
    const client = new Client({ connectionString: options.databaseUrl });
    try {
      await client.connect();
      await client.query(`listen ${CHANNEL}`);
      options.onConnected?.();
      await waitForDisconnect(client, options);
    } catch (error) {
      if (!options.signal.aborted) options.onError?.(error);
    } finally {
      options.onDisconnected?.();
      await client.end().catch(() => undefined);
    }
    if (!options.signal.aborted) {
      await abortableDelay(1_000, options.signal);
    }
  }
}

function waitForDisconnect(
  client: Client,
  options: {
    signal: AbortSignal;
    subscriber: RealtimeReplicaSubscriber;
    onError?(error: unknown): void;
    onNotification?(): void;
  },
): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      options.signal.removeEventListener("abort", finish);
      client.off("error", finish);
      resolve();
    };
    options.signal.addEventListener("abort", finish, { once: true });
    client.once("error", finish);
    client.on("notification", (notification) => {
      const parsed = parseRealtimeNotification(notification);
      if (!parsed) return;
      options.onNotification?.();
      void options.subscriber
        .handleNotification(parsed)
        .catch((error) => options.onError?.(error));
    });
  });
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      signal.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
