import {
  type GenerationSubmissionRequest,
  type GenerationSubmissionResponse,
  type SubscriptionPlan,
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
          const normalized = normalizeGenerationError(error);
          if (normalized.code === "insufficient_credits") {
            throw await enrichInsufficientCredits({
              error: normalized,
              credits: options.ports.credits,
              creditsCost,
              plan,
              workspaceId: principal.workspaceId,
              logger: options.logger,
            });
          }
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

async function enrichInsufficientCredits(options: {
  error: AppError;
  credits: NonNullable<GenerationApplicationPorts["credits"]>;
  creditsCost: number;
  plan: SubscriptionPlan;
  workspaceId: string;
  logger: StructuredLogger;
}): Promise<AppError> {
  const requiredAmount = boundedAmount(options.creditsCost);
  const details: Record<string, unknown> = {
    ...(requiredAmount !== undefined ? { requiredAmount } : {}),
    plan: options.plan,
  };
  try {
    const balance = await options.credits.getBalance(options.workspaceId);
    const safeBalance = boundedAmount(balance.balance);
    if (safeBalance !== undefined) details.balance = safeBalance;
    if (typeof balance.dailyClaimed === "boolean") {
      details.dailyClaimed = balance.dailyClaimed;
    }
  } catch (balanceError) {
    options.logger.warn("Credit balance enrichment failed", {
      stage: "balance_enrichment",
      workspaceId: options.workspaceId,
      errorName:
        balanceError instanceof Error ? balanceError.name : "UnknownError",
    });
  }
  return new AppError({
    code: "insufficient_credits",
    statusCode: 402,
    message: "Insufficient credits.",
    expose: true,
    details,
    cause: options.error,
  });
}

function boundedAmount(value: number): number | undefined {
  return Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
    ? value
    : undefined;
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
      jobId,
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
