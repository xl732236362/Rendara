import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  type CursorPage,
  INVALID_CURSOR_ERROR_CODE,
  createCursorPageSchema,
  paginationQuerySchema,
} from "./pagination.js";

describe("pagination query contract", () => {
  it("defaults the page limit to 50", () => {
    expect(paginationQuerySchema.parse({})).toEqual({ limit: 50 });
  });

  it("accepts HTTP query limits up to 100", () => {
    expect(paginationQuerySchema.parse({ limit: "100" })).toEqual({
      limit: 100,
    });
    expect(() => paginationQuerySchema.parse({ limit: "101" })).toThrow();
  });

  it("accepts an optional bounded cursor", () => {
    const cursor = "c".repeat(4_096);

    expect(paginationQuerySchema.parse({ cursor })).toEqual({
      cursor,
      limit: 50,
    });
    expect(() =>
      paginationQuerySchema.parse({ cursor: `${cursor}c` }),
    ).toThrow();
  });
});

describe("cursor page contract", () => {
  const itemSchema = z.object({ id: z.string().uuid() }).strict();
  const pageSchema = createCursorPageSchema(itemSchema);

  it("strictly parses items and the nullable next cursor", () => {
    const page = {
      items: [{ id: "9d71351d-e116-4c5f-ae82-20fb76ed6a63" }],
      nextCursor: null,
    };

    expect(pageSchema.parse(page)).toEqual(page);
    expect(() => pageSchema.parse({ ...page, total: 1 })).toThrow();
  });

  it("preserves the item type in CursorPage", () => {
    type Item = z.infer<typeof itemSchema>;
    expectTypeOf<z.infer<typeof pageSchema>>().toEqualTypeOf<
      CursorPage<Item>
    >();
  });

  it("publishes a stable invalid cursor error code", () => {
    expect(INVALID_CURSOR_ERROR_CODE).toBe("invalid_cursor");
    expectTypeOf(INVALID_CURSOR_ERROR_CODE).toEqualTypeOf<"invalid_cursor">();
  });
});
