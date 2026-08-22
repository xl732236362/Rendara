import { describe, expect, it } from "vitest";

import { createCursorCodec } from "../../pagination/cursor-codec.js";
import type { AdminSupabaseClient } from "../../supabase/admin.js";
import { createCreditService } from "./credit-service.js";

const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const workspaceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const transactions = [
  transaction("33333333-3333-4333-8333-333333333333", "2026-08-22T10:00:00.000Z"),
  transaction("22222222-2222-4222-8222-222222222222", "2026-08-22T10:00:00.000Z"),
  transaction("11111111-1111-4111-8111-111111111111", "2026-08-21T10:00:00.000Z"),
];

describe("credit service cursor pagination", () => {
  it("uses the authorized scope, requests limit + 1, orders deterministically, and trims", async () => {
    const db = database({ credit_transactions: transactions });
    const service = createCreditService({ getAdminClient: () => db.client, cursorCodec: codec() });
    const result = await service.listTransactionsPage(workspaceId, userId, { limit: 2 });

    expect(result.items).toEqual(transactions.slice(0, 2));
    expect(
      codec().decode(result.nextCursor!, {
        userId,
        workspaceId,
        owner: "credit-transactions",
        filterHash: "all",
        direction: "desc",
      }),
    ).toEqual({
      timestamp: transactions[1]!.created_at,
      id: transactions[1]!.id,
    });
    expect(db.tables[0]).toBe("credit_transactions");
    expect(db.calls).toContainEqual(["credit_transactions", "order", "created_at", { ascending: false }]);
    expect(db.calls).toContainEqual(["credit_transactions", "order", "id", { ascending: false }]);
    expect(db.calls).toContainEqual(["credit_transactions", "limit", 3]);
  });

  it("rejects a wrong authorized scope before transaction access", async () => {
    const db = database({ credit_transactions: [] });
    const cursor = codec().encode({ userId, workspaceId, owner: "other", filterHash: "all", direction: "desc" }, { timestamp: transactions[0]!.created_at, id: transactions[0]!.id });
    const service = createCreditService({ getAdminClient: () => db.client, cursorCodec: codec() });

    await expect(service.listTransactionsPage(workspaceId, userId, { cursor, limit: 2 })).rejects.toMatchObject({ code: "invalid_cursor" });
    expect(db.tables).not.toContain("credit_transactions");
  });

  it("applies the decoded descending tie-break boundary on the next page", async () => {
    const db = database({ credit_transactions: transactions.slice(1) });
    const cursor = codec().encode(
      { userId, workspaceId, owner: "credit-transactions", filterHash: "all", direction: "desc" },
      { timestamp: transactions[0]!.created_at, id: transactions[0]!.id },
    );
    const service = createCreditService({ getAdminClient: () => db.client, cursorCodec: codec() });

    const result = await service.listTransactionsPage(workspaceId, userId, { cursor, limit: 1 });

    expect(result.items.map((item) => item.id)).toEqual([transactions[1]!.id]);
    expect(db.calls).toContainEqual([
      "credit_transactions",
      "or",
      `created_at.lt.${transactions[0]!.created_at},and(created_at.eq.${transactions[0]!.created_at},id.lt.${transactions[0]!.id})`,
    ]);
    expect(db.calls).toContainEqual(["credit_transactions", "order", "created_at", { ascending: false }]);
    expect(db.calls).toContainEqual(["credit_transactions", "order", "id", { ascending: false }]);
    expect(db.calls).toContainEqual(["credit_transactions", "limit", 2]);
  });
});

function transaction(id: string, created_at: string) { return { id, transaction_type: "generation" as const, amount: -1, balance_after: 10, job_id: null, description: null, created_at }; }
function codec() { return createCursorCodec({ activeKey: { keyId: "test", secret: "test-secret-with-enough-entropy" }, now: () => Date.parse("2026-08-22T12:00:00.000Z") }); }
function database(data: Record<string, unknown[]>) {
  const calls: unknown[][] = []; const tables: string[] = [];
  const client = { from(table: string) { tables.push(table); const query: Record<string, unknown> = {}; for (const method of ["select", "eq", "order", "limit", "or"]) query[method] = (...args: unknown[]) => { calls.push([table, method, ...args]); return query; }; query.maybeSingle = async () => ({ data: (data[table] ?? [])[0] ?? null, error: null }); query.then = (resolve: (value: unknown) => unknown) => resolve({ data: data[table] ?? [], error: null }); return query; } } as unknown as AdminSupabaseClient;
  return { calls, client, tables };
}
