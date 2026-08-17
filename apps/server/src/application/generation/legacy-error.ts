import {
  type BoundaryErrorCode,
  boundaryErrorCodeSchema,
} from "@loomic/shared";

import { AppError } from "../../errors/app-error.js";

const APPROVED_LEGACY_STATUSES = {
  job_not_found: [404],
  job_create_failed: [500],
  job_cancel_failed: [500],
  model_not_accessible: [403],
  resolution_not_allowed: [403],
  concurrency_limit: [429],
  insufficient_credits: [402],
  credit_query_failed: [500],
  credit_deduct_failed: [500],
} as const satisfies Partial<Record<BoundaryErrorCode, readonly number[]>>;

/** Converts only explicitly approved legacy service failures into public application errors. */
export function normalizeGenerationError(error: unknown): AppError {
  if (error instanceof AppError) return error;

  if (isErrorWithLegacyFields(error)) {
    const parsedCode = boundaryErrorCodeSchema.safeParse(error.code);
    if (
      parsedCode.success &&
      isHttpErrorStatus(error.statusCode) &&
      isApprovedPair(parsedCode.data, error.statusCode)
    ) {
      return new AppError({
        code: parsedCode.data,
        statusCode: error.statusCode,
        message: error.message,
        expose: error.statusCode < 500,
        cause: error,
      });
    }
  }

  return new AppError({
    code: "application_error",
    statusCode: 500,
    message: "Generation operation failed.",
    cause: error,
  });
}

function isErrorWithLegacyFields(
  error: unknown,
): error is Error & { code: unknown; statusCode: unknown } {
  return error instanceof Error && "code" in error && "statusCode" in error;
}

function isHttpErrorStatus(status: unknown): status is number {
  return (
    typeof status === "number" &&
    Number.isInteger(status) &&
    status >= 400 &&
    status <= 599
  );
}

function isApprovedPair(code: BoundaryErrorCode, status: number): boolean {
  const approved = APPROVED_LEGACY_STATUSES[
    code as keyof typeof APPROVED_LEGACY_STATUSES
  ] as readonly number[] | undefined;
  return approved?.includes(status) ?? false;
}
