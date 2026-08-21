import { describe, expect, it } from "vitest";

import { buildKeysetPredicate } from "./keyset.js";

describe("buildKeysetPredicate", () => {
  const boundary = {
    timestamp: "2026-08-22T08:30:00.000Z",
    id: "9d71351d-e116-4c5f-ae82-20fb76ed6a63",
  };

  it("represents descending pagination with an id tie-break", () => {
    expect(buildKeysetPredicate("desc", boundary)).toEqual({
      operator: "or",
      branches: [
        [
          {
            field: "timestamp",
            operator: "lt",
            value: boundary.timestamp,
          },
        ],
        [
          {
            field: "timestamp",
            operator: "eq",
            value: boundary.timestamp,
          },
          { field: "id", operator: "lt", value: boundary.id },
        ],
      ],
    });
  });

  it("represents ascending pagination with the comparisons reversed", () => {
    expect(buildKeysetPredicate("asc", boundary)).toEqual({
      operator: "or",
      branches: [
        [
          {
            field: "timestamp",
            operator: "gt",
            value: boundary.timestamp,
          },
        ],
        [
          {
            field: "timestamp",
            operator: "eq",
            value: boundary.timestamp,
          },
          { field: "id", operator: "gt", value: boundary.id },
        ],
      ],
    });
  });

  it("accepts a strict RFC3339 timestamp with an explicit offset", () => {
    const offsetBoundary = {
      ...boundary,
      timestamp: "2026-08-22T16:30:00.000+08:00",
    };

    expect(buildKeysetPredicate("desc", offsetBoundary).branches[0][0]).toEqual(
      {
        field: "timestamp",
        operator: "lt",
        value: offsetBoundary.timestamp,
      },
    );
  });

  it.each([
    [
      "PostgREST syntax in timestamp",
      {
        ...boundary,
        timestamp: "2026-08-22T08:30:00.000Z,or(true)",
      },
    ],
    [
      "timestamp without an offset",
      { ...boundary, timestamp: "2026-08-22T08:30:00" },
    ],
    ["non-UUID id", { ...boundary, id: "id);drop table projects;--" }],
  ])("rejects %s before building a predicate", (_label, invalidBoundary) => {
    expect(() => buildKeysetPredicate("desc", invalidBoundary)).toThrow();
  });
});
