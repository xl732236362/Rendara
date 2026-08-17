import {
  type GenerationSubmissionRequest,
  type GenerationSubmissionResponse,
  type SubscriptionPlan,
  generationSubmissionRequestSchema,
} from "@loomic/shared";

import { createHash } from "node:crypto";
import { AppError } from "../../errors/app-error.js";
import { normalizeGenerationError } from "./legacy-error.js";
import { parseSubmissionOutcome } from "./outcome-validation.js";
import type {
  AtomicJobSubmissionCommand,
  GenerationApplicationPorts,
  GenerationPrincipal,
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
    let plan: SubscriptionPlan | undefined;
    let creditsCost: number | undefined;
    let stage = "model_resolution";
    try {
      model = options.ports.models.resolveModel(request.type, request.model);
      stage = "tier_validation";
      plan = await options.ports.tiers.getPlan(principal.workspaceId);
      options.ports.tiers.authorizeModel(plan, model);
      options.ports.tiers.authorizeMedia(plan, request);
      await options.ports.tiers.authorizeConcurrency(
        principal.workspaceId,
        plan,
      );
      creditsCost = options.ports.tiers.calculateCreditCost(model, request);

      stage = "atomic_submission";
      const submission = parseSubmissionOutcome(
        await options.ports.jobs.submit(
          toSubmissionCommand(principal, request, model, creditsCost),
        ),
      );
      jobId = submission.jobId;

      options.logger.info(
        "Generation submitted",
        logContext(principal, request.type, model, "ready", jobId),
      );
      return { jobId, status: "queued" };
    } catch (error) {
      let normalized = normalizeGenerationError(error);
      if (
        normalized.code === "insufficient_credits" &&
        options.ports.credits &&
        plan !== undefined &&
        creditsCost !== undefined
      ) {
        normalized = await enrichInsufficientCredits({
          error: normalized,
          credits: options.ports.credits,
          creditsCost,
          plan,
          workspaceId: principal.workspaceId,
          logger: options.logger,
        });
      }
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

function toSubmissionCommand(
  principal: GenerationPrincipal,
  request: GenerationSubmissionRequest,
  model: string,
  creditsCost: number,
): AtomicJobSubmissionCommand {
  const {
    type,
    idempotency_key,
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
    idempotencyKey: idempotency_key,
    requestFingerprint: createRequestFingerprint({
      type,
      project_id,
      canvas_id,
      session_id,
      thread_id,
      ...mediaPayload,
      model,
    }),
    creditsCost,
    description: `${type === "image_generation" ? "Image" : "Video"} generation: ${model}`,
    payload: { ...mediaPayload, model },
  };
}

function createRequestFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
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
