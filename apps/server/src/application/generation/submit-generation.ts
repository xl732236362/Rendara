import {
  type GenerationSubmissionRequest,
  type GenerationSubmissionResponse,
  generationSubmissionRequestSchema,
} from "@loomic/shared";

import { AppError } from "../../errors/app-error.js";
import { normalizeGenerationError } from "./legacy-error.js";
import {
  parseCancellationOutcome,
  parseSubmissionOutcome,
} from "./outcome-validation.js";
import type {
  GenerationApplicationPorts,
  GenerationPrincipal,
  JobCreateCommand,
  StructuredLogger,
} from "./ports.js";

export type SubmitGeneration = (
  principal: GenerationPrincipal,
  request: unknown,
) => Promise<GenerationSubmissionResponse>;

export function createSubmitGeneration(options: {
  ports: GenerationApplicationPorts;
  logger: StructuredLogger;
}): SubmitGeneration {
  return async (principal, rawRequest) => {
    const parsed = generationSubmissionRequestSchema.safeParse(rawRequest);
    if (!parsed.success) {
      throw new AppError({
        code: "invalid_request",
        statusCode: 400,
        message: "Invalid generation submission request.",
        expose: true,
        details: { issues: parsed.error.issues },
      });
    }

    const request = parsed.data;
    let model: string | undefined;
    let jobId: string | undefined;
    let stage = "model_resolution";
    try {
      model = options.ports.models.resolveModel(request.type, request.model);
      stage = "tier_validation";
      const plan = await options.ports.tiers.getPlan(principal.workspaceId);
      options.ports.tiers.authorizeModel(plan, model);
      options.ports.tiers.authorizeMedia(plan, request);
      await options.ports.tiers.authorizeConcurrency(
        principal.workspaceId,
        plan,
      );
      const creditsCost = options.ports.tiers.calculateCreditCost(
        model,
        request,
      );

      stage = "job_creation";
      const submission = parseSubmissionOutcome(
        await options.ports.jobs.create(
          toCreateCommand(principal, request, model),
        ),
      );
      jobId = submission.jobId;

      if (options.ports.credits && creditsCost > 0) {
        try {
          stage = "credit_deduction";
          const transactionId = await options.ports.credits.deduct({
            workspaceId: principal.workspaceId,
            userId: principal.userId,
            amount: creditsCost,
            jobId,
            description: `${request.type === "image_generation" ? "Image" : "Video"} generation: ${model}`,
          });
          stage = "credit_attachment";
          await options.ports.jobs.attachCredits(
            jobId,
            creditsCost,
            transactionId,
          );
        } catch (error) {
          await cancelAfterFailure(
            options,
            principal,
            jobId,
            model,
            request.type,
            stage,
          );
          throw error;
        }
      }

      options.logger.info(
        "Generation submitted",
        logContext(principal, request.type, model, "ready", jobId),
      );
      return { jobId, status: "queued" };
    } catch (error) {
      const normalized = normalizeGenerationError(error);
      options.logger.error(
        "Generation submission failed",
        logContext(
          principal,
          request.type,
          model,
          stage,
          jobId,
          normalized.code,
        ),
      );
      throw normalized;
    }
  };
}

function toCreateCommand(
  principal: GenerationPrincipal,
  request: GenerationSubmissionRequest,
  model: string,
): JobCreateCommand {
  const {
    type,
    project_id,
    canvas_id,
    session_id,
    thread_id,
    ...mediaPayload
  } = request;
  return {
    principal,
    workspaceId: principal.workspaceId,
    ...(project_id !== undefined ? { projectId: project_id } : {}),
    ...(canvas_id !== undefined ? { canvasId: canvas_id } : {}),
    ...(session_id !== undefined ? { sessionId: session_id } : {}),
    ...(thread_id !== undefined ? { threadId: thread_id } : {}),
    jobType: type,
    payload: { ...mediaPayload, model },
  };
}

async function cancelAfterFailure(
  options: { ports: GenerationApplicationPorts; logger: StructuredLogger },
  principal: GenerationPrincipal,
  jobId: string,
  model: string,
  type: GenerationSubmissionRequest["type"],
  failedStage: string,
) {
  try {
    parseCancellationOutcome(
      await options.ports.cancellation.cancel(principal, jobId),
    );
    options.logger.warn(
      "Generation job canceled after submission failure",
      logContext(principal, type, model, "cleanup_canceled", jobId),
    );
  } catch (cleanupError) {
    options.logger.error("Generation job cleanup failed", {
      ...logContext(principal, type, model, "cleanup_failed", jobId),
      failedStage,
      cleanupErrorName:
        cleanupError instanceof Error ? cleanupError.name : "UnknownError",
    });
  }
}

function logContext(
  principal: GenerationPrincipal,
  type: GenerationSubmissionRequest["type"],
  model: string | undefined,
  stage: string,
  jobId?: string,
  errorCode?: string,
) {
  return {
    stage,
    userId: principal.userId,
    workspaceId: principal.workspaceId,
    type,
    ...(model ? { model } : {}),
    ...(jobId ? { jobId } : {}),
    ...(errorCode ? { errorCode } : {}),
  };
}
