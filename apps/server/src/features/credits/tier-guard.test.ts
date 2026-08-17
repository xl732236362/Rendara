import { describe, expect, it } from "vitest";

import { createTierGuard } from "./tier-guard.js";

const guard = createTierGuard({ getAdminClient: () => ({}) as never });

describe("TierGuard image quality", () => {
  it.each([
    ["standard", "free", 8],
    ["hd", "pro", 12],
    ["ultra", "ultra", 20],
  ] as const)(
    "authorizes %s at its supported plan and calculates its own cost",
    (quality, plan, expectedCost) => {
      expect(() => guard.checkResolution(plan, quality)).not.toThrow();
      expect(
        guard.calculateCreditCost(
          "black-forest-labs/flux-kontext-pro",
          "image_generation",
          { quality },
        ),
      ).toBe(expectedCost);
    },
  );

  it.each([
    ["hd", "free"],
    ["ultra", "pro"],
  ] as const)("rejects %s for the lower %s plan", (quality, plan) => {
    expect(() => guard.checkResolution(plan, quality)).toThrow(
      expect.objectContaining({
        code: "resolution_not_allowed",
        statusCode: 403,
      }),
    );
  });
});
