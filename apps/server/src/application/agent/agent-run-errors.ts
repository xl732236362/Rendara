import type { AgentErrorCode } from "@loomic/shared";

import { AppError } from "../../errors/app-error.js";

export class AgentRunError extends AppError {
  readonly retryable: boolean;

  constructor(options: {
    code: AgentErrorCode;
    statusCode: number;
    message: string;
    retryable: boolean;
    cause?: unknown;
  }) {
    super({
      code: options.code,
      statusCode: options.statusCode,
      message: options.message,
      expose: true,
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    });
    this.name = "AgentRunError";
    this.retryable = options.retryable;
  }
}

export async function runWithDeadline<T>(options: {
  operation(signal: AbortSignal): Promise<T>;
  parentSignal?: AbortSignal;
  timeoutError(): Error;
  timeoutMs: number;
}): Promise<T> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be a positive finite number");
  }
  if (options.parentSignal?.aborted) {
    throw abortReason(options.parentSignal);
  }

  const controller = new AbortController();
  let rejectBoundary: ((reason: unknown) => void) | undefined;
  const boundary = new Promise<never>((_resolve, reject) => {
    rejectBoundary = reject;
  });
  const timer = setTimeout(() => {
    const error = options.timeoutError();
    rejectBoundary?.(error);
    controller.abort(error);
  }, options.timeoutMs);
  const onParentAbort = () => {
    const error = abortReason(options.parentSignal as AbortSignal);
    rejectBoundary?.(error);
    controller.abort(error);
  };
  options.parentSignal?.addEventListener("abort", onParentAbort, {
    once: true,
  });

  const operation = Promise.resolve().then(() =>
    options.operation(controller.signal),
  );
  try {
    return await Promise.race([operation, boundary]);
  } finally {
    clearTimeout(timer);
    options.parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");
}
