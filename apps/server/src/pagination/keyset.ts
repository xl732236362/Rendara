import { timestampSchema } from "@loomic/shared";
import { z } from "zod";

export type KeysetDirection = "asc" | "desc";

export const keysetBoundarySchema = z
  .object({
    timestamp: timestampSchema,
    id: z.string().uuid(),
  })
  .strict();

export type KeysetBoundary = z.infer<typeof keysetBoundarySchema>;

export type KeysetField = keyof KeysetBoundary;
export type KeysetComparisonOperator = "eq" | "gt" | "lt";

export type KeysetComparison = Readonly<{
  field: KeysetField;
  operator: KeysetComparisonOperator;
  value: string;
}>;

export type KeysetPredicate = Readonly<{
  operator: "or";
  branches: readonly [
    readonly [KeysetComparison],
    readonly [KeysetComparison, KeysetComparison],
  ];
}>;

/**
 * Produces a predicate tree from delimiter-safe RFC3339/UUID values.
 * PostgREST `.or()` has no parameter binding, so adapters must serialize only
 * this validated tree and never interpolate unparsed request values.
 */
export function buildKeysetPredicate(
  direction: KeysetDirection,
  boundary: KeysetBoundary,
): KeysetPredicate {
  const validatedBoundary = keysetBoundarySchema.parse(boundary);
  const rangeOperator = direction === "desc" ? "lt" : "gt";

  return {
    operator: "or",
    branches: [
      [
        {
          field: "timestamp",
          operator: rangeOperator,
          value: validatedBoundary.timestamp,
        },
      ],
      [
        {
          field: "timestamp",
          operator: "eq",
          value: validatedBoundary.timestamp,
        },
        { field: "id", operator: rangeOperator, value: validatedBoundary.id },
      ],
    ],
  };
}
