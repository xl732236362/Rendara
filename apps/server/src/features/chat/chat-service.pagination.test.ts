import { describe, expect, it, vi } from "vitest";

import { createCursorCodec } from "../../pagination/cursor-codec.js";
import type { UserSupabaseClient } from "../../supabase/user.js";
import { createChatService } from "./chat-service.js";

const user = { accessToken: "token", email: "u@example.com", id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", userMetadata: {} };
const workspaceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const canvasId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const sessionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const sessionRows = [
  session("33333333-3333-4333-8333-333333333333", "2026-08-22T10:00:00.000Z"),
  session("22222222-2222-4222-8222-222222222222", "2026-08-22T10:00:00.000Z"),
  session("11111111-1111-4111-8111-111111111111", "2026-08-21T10:00:00.000Z"),
];
const messageRows = [
  message("33333333-3333-4333-8333-333333333333", "2026-08-22T10:00:00.000Z"),
  message("22222222-2222-4222-8222-222222222222", "2026-08-22T10:00:00.000Z"),
  message("11111111-1111-4111-8111-111111111111", "2026-08-21T10:00:00.000Z"),
];

describe("chat service cursor pagination", () => {
  it("lists sessions newest first with a stable timestamp and id boundary", async () => {
    const db = database({ chat_sessions: sessionRows });
    const result = await service(db).listSessionsPage(user, canvasId, { limit: 2 });
    expect(result.items.map((item) => item.id)).toEqual(sessionRows.slice(0, 2).map((row) => row.id));
    expect(db.calls).toContainEqual(["chat_sessions", "order", "updated_at", { ascending: false }]);
    expect(db.calls).toContainEqual(["chat_sessions", "order", "id", { ascending: false }]);
    expect(db.calls).toContainEqual(["chat_sessions", "limit", 3]);
  });

  it("returns the newest message window chronologically and only canonical rows", async () => {
    const db = database({ chat_messages: messageRows });
    const result = await service(db).listMessagesPage(user, sessionId, { limit: 2 });
    expect(result.items.map((item) => item.id)).toEqual([
      messageRows[1]!.id,
      messageRows[0]!.id,
    ]);
    expect(db.calls.filter((call) => call[0] === "chat_messages")).toContainEqual([
      "chat_messages", "is", "superseded_by", null,
    ]);
    expect(db.calls).toContainEqual(["chat_messages", "order", "created_at", { ascending: false }]);
    expect(db.calls).toContainEqual(["chat_messages", "order", "id", { ascending: false }]);
    expect(db.calls).toContainEqual(["chat_messages", "limit", 3]);
  });

  it("prepends the next older window and keeps its cursor independent of live appends", async () => {
    const firstDb = database({ chat_messages: messageRows });
    const first = await service(firstDb).listMessagesPage(user, sessionId, { limit: 1 });
    const olderDb = database({ chat_messages: messageRows.slice(1) });
    const older = await service(olderDb).listMessagesPage(user, sessionId, {
      cursor: first.nextCursor!,
      limit: 1,
    });
    expect([...older.items, ...first.items, message("44444444-4444-4444-8444-444444444444", "2026-08-23T10:00:00.000Z")].map((item) => item.id))
      .toEqual([messageRows[1]!.id, messageRows[0]!.id, "44444444-4444-4444-8444-444444444444"]);
    expect(olderDb.calls).toContainEqual([
      "chat_messages",
      "or",
      `created_at.lt.${messageRows[0]!.created_at},and(created_at.eq.${messageRows[0]!.created_at},id.lt.${messageRows[0]!.id})`,
    ]);
  });

  it("rejects a wrong cursor scope before collection access", async () => {
    const db = database({ chat_sessions: [] });
    const cursor = codec().encode(
      { userId: user.id, workspaceId, owner: "other", filterHash: canvasId, direction: "desc" },
      { timestamp: sessionRows[0]!.updated_at, id: sessionRows[0]!.id },
    );
    await expect(service(db).listSessionsPage(user, canvasId, { cursor, limit: 1 }))
      .rejects.toMatchObject({ code: "invalid_cursor" });
    expect(db.tables).not.toContain("chat_sessions");
  });

  it("requires an injected cursor codec without reading infrastructure state", async () => {
    const db = database({});
    const subject = createChatService({
      createUserClient: () => db.client,
      threadService: { createThreadId: () => "thread-1" },
    });
    await expect(subject.listSessionsPage(user, canvasId, { limit: 1 }))
      .rejects.toThrow("CursorCodec is required for paged chat queries.");
    expect(db.tables).toEqual([]);
  });
});

function service(db: ReturnType<typeof database>) {
  return createChatService({
    createUserClient: () => db.client,
    threadService: { createThreadId: () => "thread-1" },
    cursorCodec: codec(),
    logger: { error: vi.fn() },
  });
}

function codec() {
  return createCursorCodec({
    activeKey: { keyId: "test", secret: "test-secret-with-enough-entropy" },
    now: () => Date.parse("2026-08-22T12:00:00.000Z"),
  });
}

function session(id: string, updated_at: string) {
  return { id, title: id, updated_at };
}

function message(id: string, created_at: string) {
  return { id, role: "assistant", content: id, tool_activities: null, content_blocks: null, created_at };
}

function database(data: Record<string, unknown[]>) {
  const calls: unknown[][] = [];
  const tables: string[] = [];
  const client = {
    from(table: string) {
      tables.push(table);
      const query: Record<string, unknown> = {};
      for (const method of ["select", "eq", "is", "order", "limit", "or"]) {
        query[method] = (...args: unknown[]) => {
          calls.push([table, method, ...args]);
          return query;
        };
      }
      query.maybeSingle = async () => ({
        data:
          table === "canvases"
            ? { id: canvasId, projects: { workspace_id: workspaceId } }
            : table === "chat_sessions"
              ? { id: sessionId, canvas_id: canvasId, created_by: user.id, canvases: { projects: { workspace_id: workspaceId } } }
              : null,
        error: null,
      });
      query.then = (resolve: (value: unknown) => unknown) =>
        resolve({ data: data[table] ?? [], error: null });
      return query;
    },
  } as unknown as UserSupabaseClient;
  return { calls, client, tables };
}
