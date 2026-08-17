import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { phase2TestDatabaseUrl } from "./database-test-env.js";

const databaseUrl = phase2TestDatabaseUrl();
const integration = databaseUrl ? describe : describe.skip;

integration("Phase 2 real PostgreSQL concurrency", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 6 });
  const userId = randomUUID();
  let workspaceId = "";
  const projectId = randomUUID();
  const canvasId = randomUUID();
  const jobId = randomUUID();

  beforeAll(async () => {
    await pool.query(
      `insert into auth.users
        (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
         raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
       values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated',
         'authenticated', $2, '', now(), '{}', '{}', now(), now())`,
      [userId, `phase2-${userId}@example.test`],
    );
    const workspace = await pool.query<{ id: string }>(
      "select id from public.workspaces where owner_user_id = $1 limit 1",
      [userId],
    );
    const generatedWorkspaceId = workspace.rows[0]?.id;
    if (!generatedWorkspaceId)
      throw new Error("User workspace trigger did not create a workspace");
    workspaceId = generatedWorkspaceId;
    await pool.query(
      `insert into public.projects (id, workspace_id, name, slug, created_by)
       values ($1, $2, 'Concurrency', $3, $4)`,
      [projectId, workspaceId, `phase2-${projectId}`, userId],
    );
    await pool.query(
      `insert into public.canvases (id, project_id, name, content, created_by)
       values ($1, $2, 'Canvas', '{"elements":[],"appState":{},"files":{}}', $3)`,
      [canvasId, projectId, userId],
    );
    await pool.query(
      `insert into public.background_jobs
       (id, workspace_id, queue_name, job_type, status, payload, created_by)
       values ($1, $2, 'image_generation_jobs', 'image_generation', 'queued',
         '{"prompt":"x"}', $3)`,
      [jobId, workspaceId, userId],
    );
  });

  afterAll(async () => {
    await pool.query("delete from public.background_jobs where id = $1", [
      jobId,
    ]);
    await pool.query("delete from public.canvases where id = $1", [canvasId]);
    await pool.query("delete from public.projects where id = $1", [projectId]);
    await pool.query("delete from auth.users where id = $1", [userId]);
    await pool.end();
  });

  it("allows only one concurrent lease claim", async () => {
    const [left, right] = await Promise.all([
      pool.query<{ claim_generation_job: { kind: string } }>(
        "select public.claim_generation_job($1, 'worker-a', 30)",
        [jobId],
      ),
      pool.query<{ claim_generation_job: { kind: string } }>(
        "select public.claim_generation_job($1, 'worker-b', 30)",
        [jobId],
      ),
    ]);
    const kinds = [
      left.rows[0]?.claim_generation_job.kind,
      right.rows[0]?.claim_generation_job.kind,
    ].sort();
    expect(kinds).toEqual(["busy", "claimed"]);
  });

  it("allows only one commit for the same Canvas revision", async () => {
    const commit = (source: string) =>
      pool.query(
        `select public.commit_canvas_revision(
          $1, $2, 0, $3::jsonb, null, null, 'canvas.updated', $4::jsonb)`,
        [
          canvasId,
          userId,
          JSON.stringify({
            elements: [{ id: source }],
            appState: {},
            files: {},
          }),
          JSON.stringify({ source }),
        ],
      );
    const results = await Promise.allSettled([commit("a"), commit("b")]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const persisted = await pool.query<{ revision: string }>(
      "select revision from public.canvases where id = $1",
      [canvasId],
    );
    expect(Number(persisted.rows[0]?.revision)).toBe(1);
  });

  it("rolls back a Canvas commit at the named pre-commit failpoint", async () => {
    const before = await pool.query<{ revision: string }>(
      "select revision from public.canvases where id = $1",
      [canvasId],
    );
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        "set local loomic.test_failpoint = 'before_canvas_commit'",
      );
      await expect(
        client.query(
          `select public.commit_canvas_revision(
            $1, $2, $3, '{"elements":[],"appState":{},"files":{}}',
            null, null, 'canvas.updated', '{}')`,
          [canvasId, userId, Number(before.rows[0]?.revision)],
        ),
      ).rejects.toMatchObject({ detail: "before_canvas_commit" });
      await client.query("rollback");
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
    const after = await pool.query<{ revision: string }>(
      "select revision from public.canvases where id = $1",
      [canvasId],
    );
    expect(after.rows[0]?.revision).toBe(before.rows[0]?.revision);
  });

  it.each([
    [
      "after_debit",
      `insert into public.credit_transactions
       (workspace_id, user_id, transaction_type, amount, balance_after, job_id)
       values ($1, $2, 'generation_deduct', -1, 0, $3)`,
    ],
    [
      "before_enqueue",
      `insert into public.background_jobs
       (id, workspace_id, queue_name, job_type, payload, created_by)
       values ($3, $1, 'image_generation_jobs', 'image_generation', '{}', $2)`,
    ],
    [
      "before_job_settle_commit",
      `with ignored as (select $1::uuid as workspace_id, $2::uuid as user_id)
       update public.background_jobs set status = 'succeeded', result = '{}'
       from ignored where id = $3`,
    ],
  ])("activates the local-owner-only %s failpoint", async (failpoint, sql) => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`set local loomic.test_failpoint = '${failpoint}'`);
      await expect(
        client.query(sql, [workspaceId, userId, jobId]),
      ).rejects.toMatchObject({ detail: failpoint });
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  });

  it("rolls back an outbox claim at the named post-claim failpoint", async () => {
    const eventId = randomUUID();
    await pool.query(
      `insert into public.domain_outbox
       (event_id, aggregate_type, aggregate_id, aggregate_version, event_type, payload)
       values ($1, 'canvas', $2, 99, 'canvas.test', '{}')`,
      [eventId, canvasId],
    );
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        "set local loomic.test_failpoint = 'after_outbox_claim'",
      );
      await expect(
        client.query(
          "select * from public.claim_domain_outbox(100, 'fault-worker')",
        ),
      ).rejects.toMatchObject({ detail: "after_outbox_claim" });
      await client.query("rollback");
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
    const row = await pool.query<{ locked_at: string | null }>(
      "select locked_at from public.domain_outbox where event_id = $1",
      [eventId],
    );
    expect(row.rows[0]?.locked_at).toBeNull();
    await pool.query("delete from public.domain_outbox where event_id = $1", [
      eventId,
    ]);
  });
});
