import { describe, expect, it } from "vitest";

import { createCursorCodec } from "../../pagination/cursor-codec.js";
import type { UserSupabaseClient } from "../../supabase/user.js";
import { createBrandKitService } from "./brand-kit-service.js";

const user = { accessToken: "token", email: "u@example.com", id: "user-1", userMetadata: {} };
const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const kits = [
  kit("11111111-1111-4111-8111-111111111111", "2026-08-20T10:00:00.000Z"),
  kit("22222222-2222-4222-8222-222222222222", "2026-08-20T10:00:00.000Z"),
  kit("33333333-3333-4333-8333-333333333333", "2026-08-21T10:00:00.000Z"),
];

describe("brand kit service cursor pagination", () => {
  it("requests limit + 1, uses created_at/id ascending, trims, and encodes the returned tail", async () => {
    const db = database({ brand_kits: kits, brand_kit_assets: [{ kit_id: kits[0]!.id, asset_type: "color" }] });
    const service = createBrandKitService({ createUserClient: () => db.client, cursorCodec: codec() });
    const result = await service.listKitsPage(user, workspaceId, { limit: 2 });

    expect(result.items.map((item) => item.id)).toEqual(kits.slice(0, 2).map((row) => row.id));
    expect(
      codec().decode(result.nextCursor!, {
        userId: user.id,
        workspaceId,
        owner: "brand-kits",
        filterHash: "all",
        direction: "asc",
      }),
    ).toEqual({ timestamp: kits[1]!.created_at, id: kits[1]!.id });
    expect(db.calls).toContainEqual(["brand_kits", "order", "created_at", { ascending: true }]);
    expect(db.calls).toContainEqual(["brand_kits", "order", "id", { ascending: true }]);
    expect(db.calls).toContainEqual(["brand_kits", "limit", 3]);
  });

  it("rejects a signed wrong-scope cursor before collection access", async () => {
    const db = database({ brand_kits: [] });
    const cursor = codec().encode({ userId: user.id, workspaceId, owner: "other", filterHash: "all", direction: "asc" }, { timestamp: kits[0]!.created_at, id: kits[0]!.id });
    const service = createBrandKitService({ createUserClient: () => db.client, cursorCodec: codec() });

    await expect(service.listKitsPage(user, workspaceId, { cursor, limit: 2 })).rejects.toMatchObject({ code: "invalid_cursor" });
    expect(db.tables).not.toContain("brand_kits");
  });

  it("applies the decoded ascending tie-break boundary on the next page", async () => {
    const db = database({ brand_kits: kits.slice(1), brand_kit_assets: [] });
    const cursor = codec().encode(
      { userId: user.id, workspaceId, owner: "brand-kits", filterHash: "all", direction: "asc" },
      { timestamp: kits[0]!.created_at, id: kits[0]!.id },
    );
    const service = createBrandKitService({ createUserClient: () => db.client, cursorCodec: codec() });

    const result = await service.listKitsPage(user, workspaceId, { cursor, limit: 1 });

    expect(result.items.map((item) => item.id)).toEqual([kits[1]!.id]);
    expect(db.calls).toContainEqual([
      "brand_kits",
      "or",
      `created_at.gt.${kits[0]!.created_at},and(created_at.eq.${kits[0]!.created_at},id.gt.${kits[0]!.id})`,
    ]);
    expect(db.calls).toContainEqual(["brand_kits", "order", "created_at", { ascending: true }]);
    expect(db.calls).toContainEqual(["brand_kits", "order", "id", { ascending: true }]);
    expect(db.calls).toContainEqual(["brand_kits", "limit", 2]);
  });
});

function kit(id: string, created_at: string) { return { id, name: id, is_default: false, cover_url: null, created_at, updated_at: created_at }; }
function codec() { return createCursorCodec({ activeKey: { keyId: "test", secret: "test-secret-with-enough-entropy" }, now: () => Date.parse("2026-08-22T12:00:00.000Z") }); }
function database(data: Record<string, unknown[]>) {
  const calls: unknown[][] = []; const tables: string[] = [];
  const client = { from(table: string) { tables.push(table); const query: Record<string, unknown> = {}; for (const method of ["select", "eq", "order", "limit", "in", "or"]) query[method] = (...args: unknown[]) => { calls.push([table, method, ...args]); return query; }; query.then = (resolve: (value: unknown) => unknown) => resolve({ data: data[table] ?? [], error: null }); return query; } } as unknown as UserSupabaseClient;
  return { calls, client, tables };
}
