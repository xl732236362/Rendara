import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startPostgresRealtimeListener } from "../events/postgres-realtime-listener.js";
import { createPostgresRealtimeEventStore } from "../events/realtime-event-store.js";
import { createRealtimeReplicaSubscriber } from "../events/realtime-replica-subscriber.js";
import { ConnectionManager } from "../ws/connection-manager.js";
import { phase2TestDatabaseUrl } from "./database-test-env.js";

const databaseUrl = phase2TestDatabaseUrl();
const integration = databaseUrl ? describe : describe.skip;

integration("Phase 5 real PostgreSQL realtime", () => {
  const realtimeDatabaseUrl = databaseUrl ?? "";
  const pool = new Pool({ connectionString: databaseUrl, max: 6 });
  const userId = randomUUID();
  const projectId = randomUUID();
  const canvasId = randomUUID();
  let workspaceId = "";

  beforeAll(async () => {
    await pool.query(
      `insert into auth.users
       (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
        raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
       values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated',
        'authenticated', $2, '', now(), '{}', '{}', now(), now())`,
      [userId, `phase5-${userId}@example.test`],
    );
    const workspace = await pool.query<{ id: string }>(
      "select id from public.workspaces where owner_user_id = $1 limit 1",
      [userId],
    );
    workspaceId = workspace.rows[0]?.id ?? "";
    if (!workspaceId) throw new Error("workspace_fixture_missing");
    await pool.query(
      `insert into public.projects(id, workspace_id, name, slug, created_by)
       values ($1, $2, 'Phase 5 realtime', $3, $4)`,
      [projectId, workspaceId, `phase5-${projectId}`, userId],
    );
    await pool.query(
      `insert into public.canvases(id, project_id, name, created_by)
       values ($1, $2, 'Phase 5 canvas', $3)`,
      [canvasId, projectId, userId],
    );
  });

  afterAll(async () => {
    await pool.query("delete from public.canvases where id = $1", [canvasId]);
    await pool.query("delete from public.projects where id = $1", [projectId]);
    await pool.query("delete from auth.users where id = $1", [userId]);
    await pool.end();
  });

  it("allocates unique monotonic cursors under concurrent append", async () => {
    const eventIds = Array.from({ length: 8 }, () => randomUUID());
    const rows = await Promise.all(
      eventIds.map((eventId, index) =>
        pool.query<{ canvas_seq: string }>(
          `select canvas_seq from public.append_realtime_canvas_event(
            $1, $2, 'canvas.sync', $3::jsonb, now())`,
          [eventId, canvasId, JSON.stringify({ revision: index + 1 })],
        ),
      ),
    );
    const cursors = rows
      .map((result) => Number(result.rows[0]?.canvas_seq))
      .sort((left, right) => left - right);
    expect(cursors).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("delivers a committed append through LISTEN/NOTIFY", async () => {
    const eventId = randomUUID();
    const received = vi.fn(async () => undefined);
    const abort = new AbortController();
    const listener = startPostgresRealtimeListener({
      databaseUrl: realtimeDatabaseUrl,
      signal: abort.signal,
      subscriber: {
        handleNotification: received,
        markDelivered: vi.fn(),
        reconcile: vi.fn(async () => undefined),
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    await pool.query(
      `select public.append_realtime_canvas_event(
        $1, $2, 'canvas.sync', '{"revision":9}'::jsonb, now())`,
      [eventId, canvasId],
    );
    await vi.waitFor(() => expect(received).toHaveBeenCalledOnce());
    expect(received).toHaveBeenCalledWith(
      expect.objectContaining({ canvasId, eventId, seq: 9 }),
    );

    abort.abort();
    await listener;
  });

  it("fans out from replica A to a socket on replica B and survives store restart", async () => {
    const storeA = createPostgresRealtimeEventStore(createPoolRpc(pool));
    const managerA = new ConnectionManager();
    const managerB = new ConnectionManager();
    const socketB = { readyState: 1, send: vi.fn() };
    managerB.register("connection-b", userId, socketB as never);
    managerB.bindCanvas("connection-b", canvasId);
    const subscriberA = createRealtimeReplicaSubscriber({
      store: storeA,
      pushCanvas: (boundCanvasId, event, seq) =>
        managerA.pushToCanvas(boundCanvasId, event, seq),
    });
    const subscriberB = createRealtimeReplicaSubscriber({
      store: storeA,
      pushCanvas: (boundCanvasId, event, seq) =>
        managerB.pushToCanvas(boundCanvasId, event, seq),
    });
    const abortA = new AbortController();
    const abortB = new AbortController();
    const connectedA = deferred();
    const connectedB = deferred();
    const listenerA = startPostgresRealtimeListener({
      databaseUrl: realtimeDatabaseUrl,
      signal: abortA.signal,
      subscriber: subscriberA,
      onConnected: connectedA.resolve,
      onError: (error) => {
        throw error;
      },
    });
    const listenerB = startPostgresRealtimeListener({
      databaseUrl: realtimeDatabaseUrl,
      signal: abortB.signal,
      subscriber: subscriberB,
      onConnected: connectedB.resolve,
      onError: (error) => {
        throw error;
      },
    });
    await Promise.all([connectedA.promise, connectedB.promise]);

    const eventId = randomUUID();
    const appended = await storeA.append({
      eventId,
      canvasId,
      eventType: "canvas.sync",
      payload: {
        type: "canvas.sync",
        eventId,
        canvasId,
        revision: 10,
        timestamp: "2026-08-21T00:00:00.000Z",
      },
      occurredAt: "2026-08-21T00:00:00.000Z",
    });

    await vi.waitFor(() => expect(socketB.send).toHaveBeenCalledOnce());
    expect(JSON.parse(socketB.send.mock.calls[0]?.[0] as string)).toMatchObject(
      {
        type: "event",
        seq: appended.seq,
        event: { eventId, canvasId, revision: 10 },
      },
    );

    const restartedStore = createPostgresRealtimeEventStore(
      createPoolRpc(pool),
    );
    await expect(
      restartedStore.readAfter(canvasId, appended.seq - 1, 10),
    ).resolves.toMatchObject({
      status: "replayed",
      latestSeq: appended.seq,
      events: [{ eventId, seq: appended.seq }],
    });

    abortA.abort();
    abortB.abort();
    await Promise.all([listenerA, listenerB]);
    managerA.dispose();
    managerB.dispose();
  });
});

function createPoolRpc(pool: Pool) {
  return {
    async rpc(name: string, args: Record<string, unknown>) {
      try {
        if (name === "append_realtime_canvas_event") {
          const result = await pool.query(
            "select * from public.append_realtime_canvas_event($1, $2, $3, $4::jsonb, $5)",
            [
              args.p_event_id,
              args.p_canvas_id,
              args.p_event_type,
              JSON.stringify(args.p_payload),
              args.p_occurred_at,
            ],
          );
          return {
            data: result.rows.map((row) => ({
              ...row,
              canvas_seq: Number(row.canvas_seq),
              occurred_at:
                row.occurred_at instanceof Date
                  ? row.occurred_at.toISOString()
                  : row.occurred_at,
            })),
            error: null,
          };
        }
        if (name === "get_realtime_canvas_replay_status") {
          const result = await pool.query(
            "select * from public.get_realtime_canvas_replay_status($1, $2)",
            [args.p_canvas_id, args.p_after_seq],
          );
          return {
            data: result.rows.map((row) => ({
              ...row,
              earliest_seq:
                row.earliest_seq === null ? null : Number(row.earliest_seq),
              latest_seq: Number(row.latest_seq),
              latest_revision:
                row.latest_revision == null
                  ? null
                  : Number(row.latest_revision),
            })),
            error: null,
          };
        }
        if (name === "read_realtime_canvas_events") {
          const result = await pool.query(
            "select * from public.read_realtime_canvas_events($1, $2, $3)",
            [args.p_canvas_id, args.p_after_seq, args.p_limit],
          );
          return {
            data: result.rows.map((row) => ({
              ...row,
              canvas_seq: Number(row.canvas_seq),
              occurred_at:
                row.occurred_at instanceof Date
                  ? row.occurred_at.toISOString()
                  : row.occurred_at,
            })),
            error: null,
          };
        }
        throw new Error(`unsupported_rpc:${name}`);
      } catch (error) {
        return { data: null, error };
      }
    },
  };
}

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}
