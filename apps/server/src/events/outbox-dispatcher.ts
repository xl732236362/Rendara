import { z } from "zod";

const outboxEventSchema = z.object({
  event_id: z.string().uuid(),
  aggregate_type: z.string(),
  aggregate_id: z.string().uuid(),
  aggregate_version: z.number().int().nonnegative(),
  event_type: z.string(),
  payload: z.record(z.string(), z.unknown()),
  occurred_at: z.string(),
});

export type OutboxEvent = z.infer<typeof outboxEventSchema>;

export type OutboxDependencies = {
  workerId: string;
  batchSize: number;
  claim(limit: number, workerId: string): Promise<unknown>;
  publish(event: OutboxEvent): Promise<void>;
  ack(eventId: string, workerId: string): Promise<void>;
  fail(eventId: string, workerId: string, errorCode: string): Promise<void>;
};

export async function dispatchOutboxBatch(
  deps: OutboxDependencies,
): Promise<{ claimed: number; published: number; failed: number }> {
  const events = z
    .array(outboxEventSchema)
    .parse(
      await deps.claim(
        Math.min(Math.max(deps.batchSize, 1), 100),
        deps.workerId,
      ),
    );
  let published = 0;
  let failed = 0;
  for (const event of events) {
    try {
      await deps.publish(event);
      await deps.ack(event.event_id, deps.workerId);
      published += 1;
    } catch (error) {
      failed += 1;
      await deps.fail(event.event_id, deps.workerId, safeErrorCode(error));
    }
  }
  return { claimed: events.length, published, failed };
}

export function startOutboxDispatcher(
  deps: OutboxDependencies & {
    signal: AbortSignal;
    idleDelayMs: number;
    onError?(error: unknown): void;
  },
): Promise<void> {
  return run();

  async function run() {
    while (!deps.signal.aborted) {
      try {
        const result = await dispatchOutboxBatch(deps);
        if (result.claimed === 0)
          await abortableDelay(deps.idleDelayMs, deps.signal);
      } catch (error) {
        deps.onError?.(error);
        await abortableDelay(deps.idleDelayMs, deps.signal);
      }
    }
  }
}

function safeErrorCode(error: unknown): string {
  if (error instanceof Error && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[a-z0-9_]{1,100}$/i.test(code))
      return code;
  }
  return "event_publish_failed";
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, Math.max(1, ms));
    function done() {
      signal.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
