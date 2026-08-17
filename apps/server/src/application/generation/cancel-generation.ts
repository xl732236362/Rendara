import {
  type GenerationCancellationResponse,
  generationCancellationRequestSchema,
} from "@loomic/shared";

import { AppError } from "../../errors/app-error.js";
import type {
  GenerationPrincipal,
  JobPort,
  StructuredLogger,
} from "./ports.js";

export type CancelGeneration = (
  principal: GenerationPrincipal,
  request: unknown,
) => Promise<GenerationCancellationResponse>;

export function createCancelGeneration(options: {
  jobs: JobPort;
  logger: StructuredLogger;
}): CancelGeneration {
  return async (principal, rawRequest) => {
    const parsed = generationCancellationRequestSchema.safeParse(rawRequest);
    if (!parsed.success) {
      throw new AppError({
        code: "invalid_request",
        statusCode: 400,
        message: "Invalid generation cancellation request.",
        expose: true,
        details: { issues: parsed.error.issues },
      });
    }
    const { jobId } = parsed.data;
    try {
      const job = await options.jobs.cancel(principal, jobId);
      const status = job.status === "canceled" ? "canceled" : "canceling";
      options.logger.info("Generation cancellation accepted", {
        stage: "canceled",
        jobId,
        userId: principal.userId,
        workspaceId: principal.workspaceId,
      });
      return { jobId, status };
    } catch (error) {
      const normalized = normalizeCancellationError(error);
      options.logger.error("Generation cancellation failed", {
        stage: "cancel",
        jobId,
        userId: principal.userId,
        workspaceId: principal.workspaceId,
        errorCode: normalized.code,
      });
      throw normalized;
    }
  };
}

function normalizeCancellationError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    "statusCode" in error &&
    typeof error.statusCode === "number"
  ) {
    return new AppError({
      code: error.code as AppError["code"],
      statusCode: error.statusCode,
      message: error.message,
      expose: error.statusCode < 500,
      cause: error,
    });
  }
  return new AppError({
    code: "job_cancel_failed",
    statusCode: 500,
    message: "Failed to cancel generation job.",
    cause: error,
  });
}
