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

  it("keeps untrusted boundary values as typed data", () => {
    const hostileBoundary = {
      timestamp: "2026-08-22T08:30:00.000Z,or(true)",
      id: "id);drop table projects;--",
    };

    const predicate = buildKeysetPredicate("desc", hostileBoundary);

    expect(predicate.branches[0][0].value).toBe(hostileBoundary.timestamp);
    expect(predicate.branches[1][1].value).toBe(hostileBoundary.id);
    expect(predicate).not.toEqual(expect.any(String));
  });
});
