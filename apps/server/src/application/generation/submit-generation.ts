import {
  type GenerationSubmissionRequest,
  type GenerationSubmissionResponse,
  type SubscriptionPlan,
  generationSubmissionRequestSchema,
} from "@loomic/shared";
import { z } from "zod";

import { createHash } from "node:crypto";
import { AppError } from "../../errors/app-error.js";
import { normalizeGenerationError } from "./legacy-error.js";
import { parseSubmissionOutcome } from "./outcome-validation.js";
import type {
  AgentAttachmentContext,
  AtomicJobSubmissionCommand,
  GenerationApplicationPorts,
  GenerationPrincipal,
  StructuredLogger,
} from "./ports.js";

export type SubmitGeneration = (
  principal: GenerationPrincipal,
  request: unknown,
  attachment?: AgentAttachmentContext,
) => Promise<GenerationSubmissionResponse>;

const canvasCoordinate = z.number().finite().min(-1_000_000).max(1_000_000);
const attachmentPlacementSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("auto_right") }).strict(),
  z
    .object({
      kind: z.literal("explicit"),
      x: canvasCoordinate,
      y: canvasCoordinate,
      width: z.number().finite().min(1).max(16_384),
      height: z.number().finite().min(1).max(16_384),
    })
    .strict(),
  z
    .object({
      kind: z.literal("relative"),
      elementId: z.string().trim().min(1).max(256),
      relation: z.enum(["above", "below", "left", "right"]),
      gap: z.number().finite().min(0).max(400).default(48),
      maxWidth: z.number().finite().min(1).max(4_096).optional(),
      maxHeight: z.number().finite().min(1).max(4_096).optional(),
    })
    .strict(),
]);

const agentAttachmentContextSchema = z
  .object({
    intentId: z.string().uuid(),
    runId: z.string().uuid(),
    attemptId: z.string().uuid(),
    fencingToken: z.number().int().nonnegative().safe(),
    logicalToolCallId: z.string().trim().min(1).max(200),
    inputDigest: z.string().regex(/^[0-9a-f]{64}$/),
    effectKind: z.literal("generated_asset_attached"),
    mediaType: z.enum(["image", "video"]),
    placement: attachmentPlacementSchema,
  })
  .strict();

export function createSubmitGeneration(options: {
  ports: GenerationApplicationPorts;
  logger: StructuredLogger;
}): SubmitGeneration {
  return async (principal, rawRequest, rawAttachment) => {
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
    const attachment = parseAttachmentContext(rawAttachment);
    if (attachment) {
      if (!options.ports.attachmentIntents?.isReady()) {
        throw new AppError({
          code: "application_error",
          statusCode: 503,
          message: "Generated asset attachment infrastructure is unavailable.",
          expose: false,
        });
      }
      validateAttachmentScope(request, attachment);
    }
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
      if (
        request.type === "image_generation" &&
        request.input_asset_ids?.length
      ) {
        if (!request.project_id) {
          throw new AppError({
            code: "invalid_request",
            statusCode: 400,
            message: "Reference assets require a project.",
            expose: true,
          });
        }
        if (!options.ports.referenceAssets) {
          throw new AppError({
            code: "application_error",
            statusCode: 500,
            message: "Reference asset authorization is unavailable.",
          });
        }
        stage = "reference_asset_authorization";
        await options.ports.referenceAssets.authorize({
          principal,
          projectId: request.project_id,
          assetIds: request.input_asset_ids,
        });
      }
      creditsCost = options.ports.tiers.calculateCreditCost(model, request);

      stage = "atomic_submission";
      const submission = parseSubmissionOutcome(
        await options.ports.jobs.submit(
          toSubmissionCommand(
            principal,
            request,
            model,
            creditsCost,
            attachment,
          ),
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
  attachment?: AgentAttachmentContext,
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
    ...(attachment ? { attachmentIntent: attachment } : {}),
  };
}

function parseAttachmentContext(
  attachment: AgentAttachmentContext | undefined,
): AgentAttachmentContext | undefined {
  if (attachment === undefined) return undefined;
  const parsed = agentAttachmentContextSchema.safeParse(attachment);
  if (!parsed.success) {
    throw new AppError({
      code: "invalid_request",
      statusCode: 400,
      message: "Invalid Agent attachment context.",
      expose: false,
    });
  }
  const placement = parsed.data.placement;
  return {
    ...parsed.data,
    placement:
      placement.kind === "relative"
        ? {
            kind: "relative",
            elementId: placement.elementId,
            relation: placement.relation,
            gap: placement.gap,
            ...(placement.maxWidth === undefined
              ? {}
              : { maxWidth: placement.maxWidth }),
            ...(placement.maxHeight === undefined
              ? {}
              : { maxHeight: placement.maxHeight }),
          }
        : placement,
  };
}

function validateAttachmentScope(
  request: GenerationSubmissionRequest,
  attachment: AgentAttachmentContext,
): void {
  if (!request.project_id || !request.canvas_id || !request.session_id) {
    throw new AppError({
      code: "invalid_request",
      statusCode: 400,
      message:
        "Agent attachment generation requires project, canvas, and session scope.",
      expose: false,
    });
  }
  const expectedMediaType =
    request.type === "image_generation" ? "image" : "video";
  if (attachment.mediaType !== expectedMediaType) {
    throw new AppError({
      code: "invalid_request",
      statusCode: 400,
      message:
        "Agent attachment media type does not match the generation request.",
      expose: false,
    });
  }
  if (
    attachment.mediaType === "video" &&
    attachment.placement.kind === "relative"
  ) {
    throw new AppError({
      code: "invalid_request",
      statusCode: 400,
      message: "Relative placement is supported for images only.",
      expose: false,
    });
  }
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
