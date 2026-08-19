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
