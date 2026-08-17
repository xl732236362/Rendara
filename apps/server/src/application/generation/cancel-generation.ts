import {
  type GenerationCancellationResponse,
  generationCancellationRequestSchema,
} from "@loomic/shared";

import { AppError } from "../../errors/app-error.js";
import { normalizeGenerationError } from "./legacy-error.js";
import { parseCancellationOutcome } from "./outcome-validation.js";
import type {
  GenerationCancellationPort,
  GenerationPrincipal,
  StructuredLogger,
} from "./ports.js";

export type CancelGeneration = (
  principal: GenerationPrincipal,
  request: unknown,
) => Promise<GenerationCancellationResponse>;

export function createCancelGeneration(options: {
  jobs: GenerationCancellationPort;
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
      const outcome = parseCancellationOutcome(
        await options.jobs.cancel(principal, jobId),
      );
      options.logger.info("Generation cancellation accepted", {
        stage: outcome.status,
        status: outcome.status,
        jobId,
        userId: principal.userId,
        workspaceId: principal.workspaceId,
      });
      return outcome;
    } catch (error) {
      const normalized = normalizeGenerationError(error);
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
