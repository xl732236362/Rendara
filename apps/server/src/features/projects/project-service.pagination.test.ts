import { describe, expect, it, vi } from "vitest";

import type { CursorPage } from "@loomic/shared";

import { createCursorCodec } from "../../pagination/cursor-codec.js";
import type { UserSupabaseClient } from "../../supabase/user.js";
import { createProjectService } from "./project-service.js";

const user = { accessToken: "token", email: "u@example.com", id: "user-1", userMetadata: {} };
const workspace = { id: "11111111-1111-4111-8111-111111111111", name: "Personal", type: "personal", owner_user_id: user.id };
const rows = [
  project("33333333-3333-4333-8333-333333333333", "2026-08-22T10:00:00.000Z"),
  project("22222222-2222-4222-8222-222222222222", "2026-08-22T10:00:00.000Z"),
  project("11111111-1111-4111-8111-111111111111", "2026-08-21T10:00:00.000Z"),
];

describe("project service cursor pagination", () => {
  it("requests limit + 1, orders deterministically, trims, and enriches only the page", async () => {
    const db = database({ projects: rows, canvases: rows.slice(0, 2).map((row) => ({ id: `canvas-${row.id}`, name: "Main", is_primary: true, project_id: row.id })) });
    const service = createProjectService({ createUserClient: () => db.client, viewerService: { ensureViewer: vi.fn(async () => ({} as never)) }, cursorCodec: codec() });

    const result = await service.listProjectsPage(user, { limit: 2 });

    expect(result.items.map((item) => item.id)).toEqual(rows.slice(0, 2).map((row) => row.id));
    expect(
      codec().decode(result.nextCursor!, {
        userId: user.id,
        workspaceId: workspace.id,
        owner: "projects",
        filterHash: "active",
        direction: "desc",
      }),
    ).toEqual({ timestamp: rows[1]!.updated_at, id: rows[1]!.id });
    expect(db.calls).toContainEqual(["projects", "order", "updated_at", { ascending: false }]);
    expect(db.calls).toContainEqual(["projects", "order", "id", { ascending: false }]);
    expect(db.calls).toContainEqual(["projects", "limit", 3]);
    expect(db.calls).toContainEqual(["canvases", "in", "project_id", rows.slice(0, 2).map((row) => row.id)]);
  });

  it("authorizes the workspace before decoding and rejects wrong scope before projects access", async () => {
    const db = database({ projects: [] });
    const cursor = codec().encode({ userId: user.id, workspaceId: workspace.id, owner: "other", filterHash: "active", direction: "desc" }, { timestamp: rows[0]!.updated_at, id: rows[0]!.id });
    const ensureViewer = vi.fn(async () => ({} as never));
    const service = createProjectService({ createUserClient: () => db.client, viewerService: { ensureViewer }, cursorCodec: codec() });

    await expect(service.listProjectsPage(user, { cursor, limit: 2 })).rejects.toMatchObject({ code: "invalid_cursor" });
    expect(ensureViewer).toHaveBeenCalledWith(user);
    expect(db.tables[0]).toBe("workspaces");
    expect(db.tables).not.toContain("projects");
  });

  it("applies the decoded tie-break boundary and enriches only the trimmed second page", async () => {
    const secondPageRows = [rows[1]!, rows[2]!].map((row) => ({
      ...row,
      thumbnail_path: `workspace/${row.id}/thumbnail.webp`,
    }));
    const db = database({
      projects: secondPageRows,
      canvases: [{ id: `canvas-${rows[1]!.id}`, name: "Main", is_primary: true, project_id: rows[1]!.id }],
    });
    const cursor = codec().encode(
      { userId: user.id, workspaceId: workspace.id, owner: "projects", filterHash: "active", direction: "desc" },
      { timestamp: rows[0]!.updated_at, id: rows[0]!.id },
    );
    const service = createProjectService({
      createUserClient: () => db.client,
      viewerService: { ensureViewer: vi.fn(async () => ({} as never)) },
      cursorCodec: codec(),
    });

    const result = await service.listProjectsPage(user, { cursor, limit: 1 });

    expect(result.items.map((item) => item.id)).toEqual([rows[1]!.id]);
    expect(db.calls).toContainEqual([
      "projects",
      "or",
      `updated_at.lt.${rows[0]!.updated_at},and(updated_at.eq.${rows[0]!.updated_at},id.lt.${rows[0]!.id})`,
    ]);
    expect(db.calls).toContainEqual(["projects", "order", "updated_at", { ascending: false }]);
    expect(db.calls).toContainEqual(["projects", "order", "id", { ascending: false }]);
    expect(db.calls).toContainEqual(["projects", "limit", 2]);
    expect(db.calls).toContainEqual(["canvases", "in", "project_id", [rows[1]!.id]]);
    expect(db.publicUrlPaths).toEqual([
      `workspace/${rows[1]!.id}/thumbnail.webp`,
    ]);
  });

  it("fails immediately without a cursor codec and performs no authorization or database work", async () => {
    const db = database({ projects: [] });
    const ensureViewer = vi.fn(async () => ({} as never));
    const createUserClient = vi.fn(() => db.client);
    const service = createProjectService({
      createUserClient,
      viewerService: { ensureViewer },
    });

    await expect(service.listProjectsPage(user, { limit: 1 })).rejects.toThrow(
      "CursorCodec is required for paged project queries.",
    );
    expect(ensureViewer).not.toHaveBeenCalled();
    expect(createUserClient).not.toHaveBeenCalled();
    expect(db.tables).toEqual([]);
  });

  it("logs a safe enrichment failure when a paged project has no primary canvas", async () => {
    const db = database({ projects: [rows[0]!], canvases: [] });
    const logger = { error: vi.fn() };
    const service = createProjectService({
      createUserClient: () => db.client,
      viewerService: { ensureViewer: vi.fn(async () => ({} as never)) },
      cursorCodec: codec(),
      logger,
    });

    await expect(service.listProjectsPage(user, { limit: 1 })).rejects.toMatchObject({
      code: "project_query_failed",
    });
    expect(logger.error).toHaveBeenCalledWith("pagination.query_failed", {
      collection: "projects",
      stage: "enrichment_query",
      userId: user.id,
      workspaceId: workspace.id,
    });
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("token");
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(rows[0]!.id);
  });
});

function project(id: string, updated_at: string) {
  return { id, name: id, slug: id, description: null, created_at: "2026-08-01T00:00:00.000Z", updated_at, workspace_id: workspace.id, thumbnail_path: null };
}

function codec() {
  return createCursorCodec({ activeKey: { keyId: "test", secret: "test-secret-with-enough-entropy" }, now: () => Date.parse("2026-08-22T12:00:00.000Z") });
}

function database(data: Record<string, unknown[]>) {
  const calls: unknown[][] = [];
  const tables: string[] = [];
  const publicUrlPaths: string[] = [];
  const client = {
    from(table: string) {
      tables.push(table);
      const query: Record<string, unknown> = {};
      for (const method of ["select", "eq", "is", "order", "limit", "in", "or"]) {
        query[method] = (...args: unknown[]) => { calls.push([table, method, ...args]); return query; };
      }
      query.maybeSingle = async () => ({ data: table === "workspaces" ? workspace : null, error: null });
      query.then = (resolve: (value: unknown) => unknown) => resolve({ data: data[table] ?? [], error: null });
      return query;
    },
    storage: { from: () => ({ getPublicUrl: (path: string) => { publicUrlPaths.push(path); return { data: { publicUrl: `https://assets/${path}` } }; } }) },
  } as unknown as UserSupabaseClient;
  return { calls, client, publicUrlPaths, tables };
}
