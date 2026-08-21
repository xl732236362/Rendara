import { z } from "zod";

export const PAGINATION_DEFAULT_LIMIT = 50;
export const PAGINATION_MAX_LIMIT = 100;
export const PAGINATION_MAX_CURSOR_LENGTH = 4_096;
export const INVALID_CURSOR_ERROR_CODE = "invalid_cursor" as const;

export const paginationQuerySchema = z
  .object({
    cursor: z.string().min(1).max(PAGINATION_MAX_CURSOR_LENGTH).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(PAGINATION_MAX_LIMIT)
      .default(PAGINATION_DEFAULT_LIMIT),
  })
  .strict();

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export type CursorPage<T> = {
  items: T[];
  nextCursor: string | null;
};

export function createCursorPageSchema<ItemSchema extends z.ZodType>(
  itemSchema: ItemSchema,
) {
  return z
    .object({
      items: z.array(itemSchema),
      nextCursor: z
        .string()
        .min(1)
        .max(PAGINATION_MAX_CURSOR_LENGTH)
        .nullable(),
    })
    .strict();
}
