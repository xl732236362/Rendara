import { z } from "zod";

export type RealtimeCanvasEvent = {
  eventId: string;
  canvasId: string;
  seq: number;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: string;
};

export type RealtimeReplay = {
  status: "replayed" | "caught_up" | "cursor_gap";
  earliestSeq: number | null;
  latestSeq: number;
  latestRevision: number | null;
  events: RealtimeCanvasEvent[];
};

export type RealtimeEventStore = {
  append(input: {
    eventId: string;
    canvasId: string;
    eventType: string;
    payload: Record<string, unknown>;
    occurredAt: string;
  }): Promise<{ seq: number; inserted: boolean }>;
  readAfter(
    canvasId: string,
    afterSeq: number,
    limit: number,
  ): Promise<RealtimeReplay>;
};

type RpcResult = { data: unknown; error: unknown };
type RpcClient = {
  rpc(name: string, args: Record<string, unknown>): Promise<RpcResult>;
};

const appendResultSchema = z.tuple([
  z.object({
    canvas_seq: z.number().int().positive().safe(),
    inserted: z.boolean(),
  }),
]);

const replayStatusSchema = z.tuple([
  z.object({
    earliest_seq: z.number().int().positive().safe().nullable(),
    latest_seq: z.number().int().nonnegative().safe(),
    latest_revision: z.number().int().positive().safe().nullable(),
    gap: z.boolean(),
  }),
]);

const replayEventsSchema = z.array(
  z.object({
    event_id: z.string().uuid(),
    canvas_id: z.string().uuid(),
    canvas_seq: z.number().int().positive().safe(),
    event_type: z.string().min(1),
    payload: z.record(z.string(), z.unknown()),
    occurred_at: z.string().min(1),
  }),
);

export function createPostgresRealtimeEventStore(
  client: RpcClient,
): RealtimeEventStore {
  return {
    async append(input) {
      const result = await callRpc(client, "append_realtime_canvas_event", {
        p_event_id: input.eventId,
        p_canvas_id: input.canvasId,
        p_event_type: input.eventType,
        p_payload: input.payload,
        p_occurred_at: input.occurredAt,
      });
      const [row] = appendResultSchema.parse(result);
      return { seq: row.canvas_seq, inserted: row.inserted };
    },

    async readAfter(canvasId, afterSeq, limit) {
      const [status] = replayStatusSchema.parse(
        await callRpc(client, "get_realtime_canvas_replay_status", {
          p_canvas_id: canvasId,
          p_after_seq: Math.max(0, afterSeq),
        }),
      );
      if (status.gap) {
        return {
          status: "cursor_gap",
          earliestSeq: status.earliest_seq,
          latestSeq: status.latest_seq,
          latestRevision: status.latest_revision,
          events: [],
        };
      }

      const rows = replayEventsSchema.parse(
        await callRpc(client, "read_realtime_canvas_events", {
          p_canvas_id: canvasId,
          p_after_seq: Math.max(0, afterSeq),
          p_limit: Math.min(Math.max(limit, 1), 500),
        }),
      );
      return {
        status: rows.length === 0 ? "caught_up" : "replayed",
        earliestSeq: status.earliest_seq,
        latestSeq: status.latest_seq,
        latestRevision: status.latest_revision,
        events: rows.map((row) => ({
          eventId: row.event_id,
          canvasId: row.canvas_id,
          seq: row.canvas_seq,
          eventType: row.event_type,
          payload: row.payload,
          occurredAt: row.occurred_at,
        })),
      };
    },
  };
}

async function callRpc(
  client: RpcClient,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const { data, error } = await client.rpc(name, args);
  if (error) {
    throw Object.assign(new Error("Realtime event store is unavailable."), {
      code: "realtime_store_unavailable",
    });
  }
  return data;
}
