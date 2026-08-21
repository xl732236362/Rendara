export type KeysetDirection = "asc" | "desc";

export type KeysetBoundary = {
  timestamp: string;
  id: string;
};

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
 * Produces a value-preserving predicate tree for a database adapter to bind.
 * Keeping data separate from query syntax prevents cursor values from becoming
 * executable PostgREST filter fragments.
 */
export function buildKeysetPredicate(
  direction: KeysetDirection,
  boundary: KeysetBoundary,
): KeysetPredicate {
  const rangeOperator = direction === "desc" ? "lt" : "gt";

  return {
    operator: "or",
    branches: [
      [
        {
          field: "timestamp",
          operator: rangeOperator,
          value: boundary.timestamp,
        },
      ],
      [
        { field: "timestamp", operator: "eq", value: boundary.timestamp },
        { field: "id", operator: rangeOperator, value: boundary.id },
      ],
    ],
  };
}
