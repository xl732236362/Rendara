import type { BoundaryErrorCode } from "@loomic/shared";

export type AppErrorCode = BoundaryErrorCode;

export type SafeErrorDetails = Record<string, unknown>;

export type AppErrorOptions = {
  code: AppErrorCode;
  statusCode: number;
  message: string;
  expose?: boolean;
  details?: SafeErrorDetails;
  cause?: unknown;
};

/** A transport-neutral application failure with an explicitly safe client view. */
export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly statusCode: number;
  readonly expose: boolean;
  readonly details: SafeErrorDetails | undefined;
  override readonly cause?: unknown;

  constructor(options: AppErrorOptions) {
    if (
      !Number.isInteger(options.statusCode) ||
      options.statusCode < 400 ||
      options.statusCode > 599
    ) {
      throw new TypeError(
        "AppError statusCode must be an integer from 400 to 599",
      );
    }
    if (options.message.trim().length === 0) {
      throw new TypeError("AppError message must not be empty");
    }
    const details = options.details
      ? snapshotDetails(options.details)
      : undefined;

    super(options.message, { cause: options.cause });
    this.name = "AppError";
    this.code = options.code;
    this.statusCode = options.statusCode;
    this.expose = options.expose ?? false;
    this.details = details;
    this.cause = options.cause;
  }
}

function snapshotDetails(details: SafeErrorDetails): SafeErrorDetails {
  try {
    if (!isJsonSafe(details, new WeakSet())) {
      throw new TypeError("invalid details");
    }
    const serialized = JSON.stringify(details);
    const snapshot = JSON.parse(serialized) as SafeErrorDetails;
    return deepFreeze(snapshot);
  } catch {
    throw new TypeError("AppError details must contain JSON-safe values");
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function isJsonSafe(value: unknown, ancestors: WeakSet<object>): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "object") {
    return false;
  }
  if (ancestors.has(value)) {
    return false;
  }

  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonSafe(item, ancestors))
    : (Object.getPrototypeOf(value) === Object.prototype ||
        Object.getPrototypeOf(value) === null) &&
      Object.values(value).every((item) => isJsonSafe(item, ancestors));
  ancestors.delete(value);
  return valid;
}
