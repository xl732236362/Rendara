import { describe, expect, it } from "vitest";

import { CreditServiceError } from "../../features/credits/credit-service.js";
import { TierGuardError } from "../../features/credits/tier-guard.js";
import { JobServiceError } from "../../features/jobs/job-service.js";
import { normalizeGenerationError } from "./legacy-error.js";

describe("normalizeGenerationError", () => {
  it.each([
    [
      new JobServiceError("job_not_found", "Job not found", 404),
      "job_not_found",
      404,
    ],
    [
      new JobServiceError("job_create_failed", "Create failed", 500),
      "job_create_failed",
      500,
    ],
    [
      new TierGuardError("model_not_accessible", "Upgrade", 403),
      "model_not_accessible",
      403,
    ],
    [
      new TierGuardError("concurrency_limit", "Busy", 429),
      "concurrency_limit",
      429,
    ],
    [
      new CreditServiceError("insufficient_credits", "Insufficient", 402),
      "insufficient_credits",
      402,
    ],
    [
      new CreditServiceError("credit_deduct_failed", "Deduct failed", 500),
      "credit_deduct_failed",
      500,
    ],
  ])("preserves approved legacy error %#", (legacy, code, statusCode) => {
    expect(normalizeGenerationError(legacy)).toMatchObject({
      code,
      statusCode,
      cause: legacy,
    });
  });

  it("preserves only bounded safe billing metadata from a trusted legacy error", () => {
    const legacy = Object.assign(
      new CreditServiceError("insufficient_credits", "Insufficient", 402),
      {
        currentBalance: 2,
        requiredAmount: 7,
        plan: "free",
        dailyClaimed: true,
        secret: "must-not-cross",
      },
    );

    expect(normalizeGenerationError(legacy).details).toEqual({
      currentBalance: 2,
      requiredAmount: 7,
      plan: "free",
      dailyClaimed: true,
    });
  });

  it.each([
    Object.assign(new Error("unknown"), {
      code: "not_a_boundary_code",
      statusCode: 500,
    }),
    Object.assign(new Error("nan"), {
      code: "job_create_failed",
      statusCode: Number.NaN,
    }),
    Object.assign(new Error("too high"), {
      code: "job_create_failed",
      statusCode: 999,
    }),
    Object.assign(new Error("string"), {
      code: "job_create_failed",
      statusCode: "500",
    }),
    Object.assign(new Error("wrong pairing"), {
      code: "job_not_found",
      statusCode: 500,
    }),
  ])(
    "privately maps malformed or unapproved errors without throwing %#",
    (legacy) => {
      expect(normalizeGenerationError(legacy)).toMatchObject({
        code: "application_error",
        statusCode: 500,
        expose: false,
        cause: legacy,
      });
    },
  );
});
