import { describe, expect, it, vi } from "vitest";

import { createCursorCodec } from "../../pagination/cursor-codec.js";
import type { UserSupabaseClient } from "../../supabase/user.js";
import { createChatService } from "./chat-service.js";

const user = {
  accessToken: "token",
  email: "u@example.com",
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  userMetadata: {},
};
const workspaceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const canvasId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const sessionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const sessionRows = [
  session("44444444-4444-4444-8444-444444444444", "2026-08-22T11:00:00.000Z"),
  session("33333333-3333-4333-8333-333333333333", "2026-08-22T10:00:00.000Z"),
  session("22222222-2222-4222-8222-222222222222", "2026-08-22T10:00:00.000Z"),
  session("11111111-1111-4111-8111-111111111111", "2026-08-21T10:00:00.000Z"),
];
const messageRows = [
  message("44444444-4444-4444-8444-444444444444", "2026-08-22T11:00:00.000Z"),
  message("33333333-3333-4333-8333-333333333333", "2026-08-22T10:00:00.000Z"),
  message("22222222-2222-4222-8222-222222222222", "2026-08-22T10:00:00.000Z"),
  message("11111111-1111-4111-8111-111111111111", "2026-08-21T10:00:00.000Z"),
  message(
    "99999999-9999-4999-8999-999999999999",
    "2026-08-23T10:00:00.000Z",
    "44444444-4444-4444-8444-444444444444",
  ),
];

describe("chat service cursor pagination", () => {
  it("walks session pages newest first across an identical-timestamp ID boundary", async () => {
    const db = database({
      chat_sessions: [
        sessionRows[2]!,
        sessionRows[0]!,
        sessionRows[3]!,
        sessionRows[1]!,
      ],
    });
    const subject = service(db);
    const first = await subject.listSessionsPage(user, canvasId, { limit: 2 });
    const second = await subject.listSessionsPage(user, canvasId, {
      cursor: first.nextCursor!,
      limit: 2,
    });

    expect(first.items.map((item) => item.id)).toEqual([
      sessionRows[0]!.id,
      sessionRows[1]!.id,
    ]);
    expect(second.items.map((item) => item.id)).toEqual([
      sessionRows[2]!.id,
      sessionRows[3]!.id,
    ]);
    expect([...first.items, ...second.items].map((item) => item.id)).toEqual(
      sessionRows.map((row) => row.id),
    );
    expect(second.nextCursor).toBeNull();
    expect(db.calls).toContainEqual(["chat_sessions", "limit", 3]);
  });

  it("walks canonical message windows chronologically while live appends leave the older cursor stable", async () => {
    const db = database({
      chat_messages: [
        messageRows[2]!,
        messageRows[4]!,
        messageRows[0]!,
        messageRows[3]!,
        messageRows[1]!,
      ],
    });
    const subject = service(db);
    const newest = await subject.listMessagesPage(user, sessionId, {
      limit: 2,
    });
    db.rows.chat_messages!.push(
      message(
        "55555555-5555-4555-8555-555555555555",
        "2026-08-24T10:00:00.000Z",
      ),
    );
    const older = await subject.listMessagesPage(user, sessionId, {
      cursor: newest.nextCursor!,
      limit: 2,
    });

    expect(newest.items.map((item) => item.id)).toEqual([
      messageRows[1]!.id,
      messageRows[0]!.id,
    ]);
    expect(older.items.map((item) => item.id)).toEqual([
      messageRows[3]!.id,
      messageRows[2]!.id,
    ]);
    const combined = [...older.items, ...newest.items];
    expect(combined.map((item) => item.id)).toEqual([
      messageRows[3]!.id,
      messageRows[2]!.id,
      messageRows[1]!.id,
      messageRows[0]!.id,
    ]);
    expect(new Set(combined.map((item) => item.id)).size).toBe(combined.length);
    expect(older.nextCursor).toBeNull();
    expect(JSON.stringify(combined)).not.toContain(
      "99999999-9999-4999-8999-999999999999",
    );
    expect(JSON.stringify(combined)).not.toContain(
      "55555555-5555-4555-8555-555555555555",
    );
    expect(db.calls).toContainEqual(["chat_messages", "limit", 3]);
  });

  it("rejects a wrong cursor scope before collection access", async () => {
    const db = database({ chat_sessions: [] });
    const cursor = codec().encode(
      {
        userId: user.id,
        workspaceId,
        owner: "other",
        filterHash: canvasId,
        direction: "desc",
      },
      { timestamp: sessionRows[0]!.updated_at, id: sessionRows[0]!.id },
    );
    await expect(
      service(db).listSessionsPage(user, canvasId, { cursor, limit: 1 }),
    ).rejects.toMatchObject({ code: "invalid_cursor" });
    expect(db.tables).not.toContain("chat_sessions");
  });

  it("requires an injected cursor codec without reading infrastructure state", async () => {
    const db = database({});
    const subject = createChatService({
      createUserClient: () => db.client,
      threadService: { createThreadId: () => "thread-1" },
    });
    await expect(
      subject.listSessionsPage(user, canvasId, { limit: 1 }),
    ).rejects.toThrow("CursorCodec is required for paged chat queries.");
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
  return {
    id,
    title: id,
    updated_at,
    canvas_id: canvasId,
    created_by: user.id,
  };
}

function message(
  id: string,
  created_at: string,
  superseded_by: string | null = null,
) {
  return {
    id,
    role: "assistant",
    content: id,
    tool_activities: null,
    content_blocks: null,
    created_at,
    session_id: sessionId,
    superseded_by,
  };
}

type Row = Record<string, unknown>;

function database(initialRows: Record<string, Row[]>) {
  const calls: unknown[][] = [];
  const tables: string[] = [];
  const rows = Object.fromEntries(
    Object.entries(initialRows).map(([table, values]) => [table, [...values]]),
  ) as Record<string, Row[]>;
  const client = {
    from(table: string) {
      tables.push(table);
      const equals: Array<[string, unknown]> = [];
      const nulls: string[] = [];
      const orders: Array<[string, boolean]> = [];
      let boundary:
        | { column: string; timestamp: string; id: string }
        | undefined;
      let rowLimit: number | undefined;
      const query: Record<string, unknown> = {};
      query.select = (...args: unknown[]) => {
        calls.push([table, "select", ...args]);
        return query;
      };
      query.eq = (column: string, value: unknown) => {
        calls.push([table, "eq", column, value]);
        equals.push([column, value]);
        return query;
      };
      query.is = (column: string, value: null) => {
        calls.push([table, "is", column, value]);
        nulls.push(column);
        return query;
      };
      query.order = (column: string, options: { ascending: boolean }) => {
        calls.push([table, "order", column, options]);
        orders.push([column, options.ascending]);
        return query;
      };
      query.limit = (limit: number) => {
        calls.push([table, "limit", limit]);
        rowLimit = limit;
        return query;
      };
      query.or = (predicate: string) => {
        calls.push([table, "or", predicate]);
        const match = predicate.match(
          /^(\w+)\.lt\.([^,]+),and\(\1\.eq\.([^,]+),id\.lt\.([^)]+)\)$/,
        );
        if (!match || match[2] !== match[3]) throw new Error("invalid keyset");
        boundary = { column: match[1]!, timestamp: match[2]!, id: match[4]! };
        return query;
      };
      query.maybeSingle = async () => ({
        data:
          table === "canvases"
            ? { id: canvasId, projects: { workspace_id: workspaceId } }
            : table === "chat_sessions"
              ? {
                  id: sessionId,
                  canvas_id: canvasId,
                  created_by: user.id,
                  canvases: { projects: { workspace_id: workspaceId } },
                }
              : null,
        error: null,
      });
      // biome-ignore lint/suspicious/noThenProperty: Supabase query builders are PromiseLike by contract.
      query.then = (resolve: (value: unknown) => unknown) => {
        let result = [...(rows[table] ?? [])];
        result = result.filter((row) =>
          equals.every(([column, value]) => row[column] === value),
        );
        result = result.filter((row) =>
          nulls.every((column) => row[column] == null),
        );
        if (boundary) {
          result = result.filter((row) => {
            const timestamp = row[boundary!.column] as string;
            return (
              timestamp < boundary!.timestamp ||
              (timestamp === boundary!.timestamp &&
                (row.id as string) < boundary!.id)
            );
          });
        }
        result.sort((left, right) => {
          for (const [column, ascending] of orders) {
            const comparison = String(left[column]).localeCompare(
              String(right[column]),
            );
            if (comparison !== 0) return ascending ? comparison : -comparison;
          }
          return 0;
        });
        if (rowLimit !== undefined) result = result.slice(0, rowLimit);
        return resolve({ data: result, error: null });
      };
      return query;
    },
  } as unknown as UserSupabaseClient;
  return { calls, client, rows, tables };
}
