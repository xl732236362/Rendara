import {
  type GenerationCancellationResponse,
  type GenerationSubmissionResponse,
  generationCancellationResponseSchema,
  generationSubmissionResponseSchema,
} from "@loomic/shared";

import { AppError } from "../../errors/app-error.js";
import type {
  GenerationCancellationOutcome,
  GenerationSubmissionOutcome,
} from "./ports.js";

export function parseSubmissionOutcome(
  outcome: GenerationSubmissionOutcome,
): GenerationSubmissionResponse {
  const parsed = generationSubmissionResponseSchema.safeParse({
    jobId: outcome.id,
    status: outcome.status,
  });
  if (!parsed.success) throw invalidAdapterOutcome();
  return parsed.data;
}

export function parseCancellationOutcome(
  outcome: GenerationCancellationOutcome,
  expectedJobId: string,
): GenerationCancellationResponse {
  const parsed = generationCancellationResponseSchema.safeParse({
    jobId: outcome.id,
    status: outcome.status,
  });
  if (!parsed.success || parsed.data.jobId !== expectedJobId) {
    throw invalidAdapterOutcome();
  }
  return parsed.data;
}

function invalidAdapterOutcome(): AppError {
  return new AppError({
    code: "application_error",
    statusCode: 500,
    message: "Generation adapter returned an invalid outcome.",
  });
}
