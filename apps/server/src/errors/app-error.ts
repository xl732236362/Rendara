import type { BoundaryErrorCode } from "@loomic/shared";

export type AppErrorCode = BoundaryErrorCode | (string & Record<never, never>);

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
    super(options.message, { cause: options.cause });
    this.name = "AppError";
    this.code = options.code;
    this.statusCode = options.statusCode;
    this.expose = options.expose ?? false;
    this.details = options.details;
    this.cause = options.cause;
  }
}
