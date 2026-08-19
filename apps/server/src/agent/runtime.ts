// @credits-system — Agent tool runtime with credit checks before image/video generation
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import { HumanMessage } from "@langchain/core/messages";
import type {
  ImageAttachment,
  ImageGenerationPreference,
  MessageMention,
  RunCancelResponse,
  RunCreateRequest,
  RunCreateResponse,
  StreamEvent,
  VideoGenerationPreference,
} from "@loomic/shared";

import {
  type BillingErrorCode,
  type ImageQualityLevel,
  getPlanConfig,
} from "@loomic/shared";
import {
  AgentRunError,
  runWithDeadline,
} from "../application/agent/agent-run-errors.js";
import type { ApplyCanvasOperations } from "../application/canvas/apply-canvas-operations.js";
import type { GeneratedAssetAttachmentRecovery } from "../application/canvas/attach-generated-asset.js";
import type {
  AgentAttachmentContext,
  AgentAttachmentPlacement,
} from "../application/generation/ports.js";
import type { SubmitGeneration } from "../application/generation/submit-generation.js";
import type { ServerEnv } from "../config/env.js";
import { AppError } from "../errors/app-error.js";
import type {
  AgentExecutionRepository,
  AgentTerminalStatus,
} from "../features/agent-runs/agent-execution-repository.js";
import {
  AgentFinalizationUnconfirmedError,
  type AgentRunMetadataService,
  finalizeAgentRun,
} from "../features/agent-runs/agent-run-service.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { CreditService } from "../features/credits/credit-service.js";
import {
  type TierGuard,
  TierGuardError,
} from "../features/credits/tier-guard.js";
import type { JobService } from "../features/jobs/job-service.js";
import type { ProviderCatalog } from "../generation/providers/registry.js";
import type { UserSupabaseClient } from "../supabase/user.js";
import { sanitizeErrorForClient } from "../utils/error-sanitizer.js";
import type { ConnectionManager } from "../ws/connection-manager.js";
import { createPipelineLogger } from "../ws/logger.js";
import type { BuiltinSkillCatalog } from "./builtin-skills/catalog.js";
import {
  type AgentCapability,
  PRODUCTION_AGENT_CAPABILITIES,
  createAgentAuthority,
} from "./capabilities.js";
import type { AgentExecutionContext } from "./execution-context.js";
import {
  type LoomicAgent,
  type LoomicAgentFactory,
  createDefaultModelSpecifier,
  createLoomicAgent,
} from "./loomic-agent.js";
import type { AgentPersistenceService } from "./persistence/index.js";
import { adaptDeepAgentStream, toPublicToolEvent } from "./stream-adapter.js";
import type { SubmitImageJobFn } from "./tools/image-generate.js";
import type { SubmitVideoJobFn } from "./tools/video-generate.js";

/**
 * Build the text portion of a user message, appending <input_images> XML
 * tags when attachments are present so the LLM can reference them by assetId.
 */
export function buildUserMessage(
  prompt: string,
  attachments: ImageAttachment[],
  imageGenerationPreference?: ImageGenerationPreference,
  mentions: MessageMention[] = [],
  videoGenerationPreference?: VideoGenerationPreference,
): { text: string } {
  const xmlBlocks: string[] = [];

  const inputImagesXml = buildInputImagesXml(attachments);
  if (inputImagesXml) xmlBlocks.push(inputImagesXml);

  const imageGenerationPreferenceXml = buildImageGenerationPreferenceXml(
    imageGenerationPreference,
  );
  if (imageGenerationPreferenceXml)
    xmlBlocks.push(imageGenerationPreferenceXml);

  const videoGenerationPreferenceXml = buildVideoGenerationPreferenceXml(
    videoGenerationPreference,
  );
  if (videoGenerationPreferenceXml)
    xmlBlocks.push(videoGenerationPreferenceXml);

  const mentionXmlBlocks = buildMentionXmlBlocks(mentions);
  xmlBlocks.push(...mentionXmlBlocks);

  if (!xmlBlocks.length) return { text: prompt };
  return { text: `${prompt}\n\n${xmlBlocks.join("\n\n")}` };
}

function buildInputImagesXml(attachments: ImageAttachment[]): string | null {
  if (attachments.length === 0) return null;

  const imageXml = attachments
    .map((attachment, i) => {
      const nameAttr = attachment.name
        ? ` name="${escapeXmlAttribute(attachment.name)}"`
        : "";
      return `<image index="${i + 1}" asset_id="${escapeXmlAttribute(attachment.assetId)}" mime_type="${escapeXmlAttribute(attachment.mimeType)}"${nameAttr} />`;
    })
    .join("\n  ");

  return `<input_images count="${attachments.length}">\n  ${imageXml}\n</input_images>`;
}

function buildImageGenerationPreferenceXml(
  imageGenerationPreference?: ImageGenerationPreference,
): string | null {
  if (
    imageGenerationPreference?.mode !== "manual" ||
    imageGenerationPreference.models.length === 0
  ) {
    return null;
  }

  const modelXml = imageGenerationPreference.models
    .map(
      (model, i) =>
        `<preferred_model index="${i + 1}" id="${escapeXmlAttribute(model)}" />`,
    )
    .join("\n  ");

  return `<human_image_generation_preference mode="manual" count="${imageGenerationPreference.models.length}">\n  ${modelXml}\n</human_image_generation_preference>`;
}

function buildVideoGenerationPreferenceXml(
  videoGenerationPreference?: VideoGenerationPreference,
): string | null {
  if (
    videoGenerationPreference?.mode !== "manual" ||
    videoGenerationPreference.models.length === 0
  ) {
    return null;
  }

  const modelXml = videoGenerationPreference.models
    .map(
      (model, i) =>
        `<preferred_model index="${i + 1}" id="${escapeXmlAttribute(model)}" />`,
    )
    .join("\n  ");

  return `<human_video_generation_preference mode="manual" count="${videoGenerationPreference.models.length}">\n  ${modelXml}\n</human_video_generation_preference>`;
}

function buildMentionXmlBlocks(mentions: MessageMention[]): string[] {
  const xmlBlocks: string[] = [];

  const mentionedModels = mentions.filter(
    (
      mention,
    ): mention is Extract<MessageMention, { mentionType: "image-model" }> =>
      mention.mentionType === "image-model",
  );
  if (mentionedModels.length > 0) {
    const modelXml = mentionedModels
      .map(
        (mention, i) =>
          `<model index="${i + 1}" id="${escapeXmlAttribute(mention.id)}" display_name="${escapeXmlAttribute(mention.label)}" />`,
      )
      .join("\n  ");

    xmlBlocks.push(
      `<human_image_model_mentions count="${mentionedModels.length}">\n  ${modelXml}\n</human_image_model_mentions>`,
    );
  }

  const mentionedBrandKitAssets = mentions.filter(
    (
      mention,
    ): mention is Extract<MessageMention, { mentionType: "brand-kit-asset" }> =>
      mention.mentionType === "brand-kit-asset",
  );
  if (mentionedBrandKitAssets.length > 0) {
    const assetXml = mentionedBrandKitAssets
      .map((mention, i) => {
        const textContentAttr =
          mention.textContent != null
            ? ` text_content="${escapeXmlAttribute(mention.textContent)}"`
            : "";
        const fileUrlAttr =
          mention.fileUrl != null
            ? ` file_url="${escapeXmlAttribute(mention.fileUrl)}"`
            : "";
        return `<brand_kit_asset index="${i + 1}" id="${escapeXmlAttribute(mention.id)}" type="${escapeXmlAttribute(mention.assetType)}" display_name="${escapeXmlAttribute(mention.label)}"${textContentAttr}${fileUrlAttr} />`;
      })
      .join("\n  ");

    xmlBlocks.push(
      `<human_brand_kit_mentions count="${mentionedBrandKitAssets.length}">\n  ${assetXml}\n</human_brand_kit_mentions>`,
    );
  }

  return xmlBlocks;
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Build a lookup map from assetId to base64 data URI.
 * Stored in configurable so tools can resolve assetId references.
 */
export function buildAttachmentDataMap(
  downloaded: Array<{ assetId: string; mimeType: string; base64: string }>,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const d of downloaded) {
    map[d.assetId] = `data:${d.mimeType};base64,${d.base64}`;
  }
  return map;
}

type RuntimeRunStatus =
  | "accepted"
  | "canceled"
  | "completed"
  | "failed"
  | "running";

type RuntimeRunRecord = RunCreateRequest & {
  accessToken?: string;
  consumed: boolean;
  controller: AbortController;
  modelOverride?: string;
  runId: string;
  status: RuntimeRunStatus;
  threadId?: string;
  userId?: string;
  attemptId?: string;
  fencingToken?: number;
};

type CreateAgentRuntimeOptions = {
  agentExecutionRepository?: AgentExecutionRepository;
  builtinSkillCatalog?: BuiltinSkillCatalog;
  agentPersistenceService?: AgentPersistenceService;
  applyCanvasOperations?: ApplyCanvasOperations;
  generatedAssetAttachments?: GeneratedAssetAttachmentRecovery;
  agentFactory?: LoomicAgentFactory;
  agentRunMetadataService?: AgentRunMetadataService;
  connectionManager?: ConnectionManager;
  createUserClient?: (accessToken: string) => unknown;
  creditService?: CreditService;
  env: ServerEnv;
  eventDelayMs?: number;
  firstEventTimeoutMs?: number;
  finalizationRetryDelayMs?: number;
  jobService?: JobService;
  model?: BaseLanguageModel | string;
  providerRegistry: ProviderCatalog;
  persistenceTimeoutMs?: number;
  now?: () => string;
  runIdFactory?: () => string;
  tierGuard?: TierGuard;
  submitGeneration?: SubmitGeneration;
  viewerService?: ViewerService;
};

export type AgentRunService = ReturnType<typeof createAgentRunService>;

export function createAgentRunService(options: CreateAgentRuntimeOptions) {
  const now = options.now ?? (() => new Date().toISOString());
  const runs = new Map<string, RuntimeRunRecord>();
  const runIdFactory = options.runIdFactory ?? (() => randomUUID());
  const firstEventTimeoutMs = options.firstEventTimeoutMs ?? 30_000;
  const persistenceTimeoutMs = options.persistenceTimeoutMs ?? 10_000;
  const createUserClientForCanvas = options.createUserClient;
  const resolveCanvasScope = createUserClientForCanvas
    ? async (context: { accessToken: string; canvasId: string }) => {
        const client = createUserClientForCanvas(
          context.accessToken,
        ) as UserSupabaseClient;
        const { data, error } = await client
          .from("canvases")
          .select("id, project_id, projects!inner(workspace_id)")
          .eq("id", context.canvasId)
          .maybeSingle();
        const canvas = data as unknown as {
          id?: string;
          project_id?: string;
          projects?: { workspace_id?: string };
        } | null;
        const workspaceId = canvas?.projects?.workspace_id;
        if (
          error ||
          canvas?.id !== context.canvasId ||
          !canvas.project_id ||
          !workspaceId
        ) {
          throw new Error("Canvas not found or access denied");
        }
        return { projectId: canvas.project_id, workspaceId };
      }
    : undefined;
  const resolveWorkspaceId =
    options.applyCanvasOperations && resolveCanvasScope
      ? async (context: {
          accessToken: string;
          userId: string;
          canvasId: string;
        }) => {
          const scope = await resolveCanvasScope(context);
          return scope.workspaceId;
        }
      : undefined;

  const resolvedAgentFactory: LoomicAgentFactory =
    options.agentFactory ??
    ((agentOptions) =>
      createLoomicAgent({
        ...agentOptions,
        providerRegistry: options.providerRegistry,
        ...(options.createUserClient
          ? { createUserClient: options.createUserClient }
          : {}),
        ...(options.applyCanvasOperations && resolveWorkspaceId
          ? {
              applyCanvasOperations: options.applyCanvasOperations,
              resolveWorkspaceId,
            }
          : {}),
      }));

  // ── Billing error helper: push WS event + abort run ──────────
  function pushBillingErrorAndAbort(
    run: { runId: string; conversationId: string; controller: AbortController },
    canvasId: string | undefined,
    opts: { connectionManager?: ConnectionManager },
    code: BillingErrorCode,
    message: string,
    extra?: {
      currentBalance?: number;
      requiredAmount?: number;
      plan?: string;
      dailyClaimed?: boolean;
    },
  ): void {
    const canvasTarget = canvasId ?? run.conversationId;
    if (!opts.connectionManager || !canvasTarget) {
      console.warn(
        `[billing] pushBillingErrorAndAbort: no connectionManager or canvasTarget, billing.error (${code}) not sent to client`,
      );
    } else {
      opts.connectionManager.pushToCanvas(canvasTarget, {
        type: "billing.error",
        runId: run.runId,
        timestamp: new Date().toISOString(),
        code,
        message,
        ...extra,
      });
    }
    if (!run.controller.signal.aborted) {
      run.controller.abort();
    }
  }

  function handleBillingSubmissionError(
    error: unknown,
    run: RuntimeRunRecord,
  ): void {
    if (!(error instanceof AppError) || !isBillingErrorCode(error.code)) return;
    const details = error.details;
    pushBillingErrorAndAbort(
      run,
      run.canvasId,
      options,
      error.code,
      error.expose ? error.message : "Generation request was rejected.",
      {
        ...(typeof details?.balance === "number"
          ? { currentBalance: details.balance }
          : {}),
        ...(typeof details?.requiredAmount === "number"
          ? { requiredAmount: details.requiredAmount }
          : {}),
        ...(typeof details?.plan === "string" ? { plan: details.plan } : {}),
        ...(typeof details?.dailyClaimed === "boolean"
          ? { dailyClaimed: details.dailyClaimed }
          : {}),
      },
    );
  }

  type RunRegistrationOptions = {
    accessToken?: string;
    durableCreated: boolean;
    model?: string;
    runId: string;
    threadId?: string;
    userId?: string;
  };

  function registerRun(
    input: RunCreateRequest,
    runOptions: RunRegistrationOptions,
  ): {
    ownership: "created" | "existing_active" | "rehydrated";
    response: RunCreateResponse;
  } {
    const existing = runs.get(runOptions.runId);
    if (existing) {
      return {
        ownership: "existing_active",
        response: {
          conversationId: existing.conversationId,
          runId: runOptions.runId,
          sessionId: existing.sessionId,
          status: "accepted",
        },
      };
    }

    const { accessToken: _ignoredAccessToken, ...runInput } = input;
    runs.set(runOptions.runId, {
      ...runInput,
      ...(runOptions.accessToken
        ? { accessToken: runOptions.accessToken }
        : {}),
      consumed: false,
      controller: new AbortController(),
      ...(runOptions.model ? { modelOverride: runOptions.model } : {}),
      ...(runOptions.threadId ? { threadId: runOptions.threadId } : {}),
      ...(runOptions.userId ? { userId: runOptions.userId } : {}),
      runId: runOptions.runId,
      status: "accepted",
    });

    return {
      ownership: runOptions.durableCreated ? "created" : "rehydrated",
      response: {
        conversationId: input.conversationId,
        runId: runOptions.runId,
        sessionId: input.sessionId,
        status: "accepted",
      },
    };
  }

  return {
    async cancelRun(runId: string): Promise<RunCancelResponse | null> {
      const run = runs.get(runId);
      if (!run) {
        return null;
      }

      if (isTerminalStatus(run.status)) {
        return { runId, status: "canceled" };
      }

      if (!run.controller.signal.aborted) run.controller.abort();

      const finalized = await finalizeRuntimeRun(
        options.agentExecutionRepository,
        run,
        "canceled",
        {},
        options.finalizationRetryDelayMs,
      );
      run.status = finalized ?? "canceled";
      return {
        runId,
        status: "canceled",
      };
    },

    createRun(
      input: RunCreateRequest,
      runOptions?: {
        accessToken?: string;
        model?: string;
        runId?: string;
        threadId?: string;
        userId?: string;
      },
    ): RunCreateResponse {
      const runId = runOptions?.runId ?? runIdFactory();
      return registerRun(input, {
        durableCreated: true,
        runId,
        ...runOptions,
      }).response;
    },

    registerRun,

    hasRun(runId: string) {
      return runs.has(runId);
    },

    async *streamRun(runId: string): AsyncGenerator<StreamEvent> {
      const run = runs.get(runId);
      if (!run) {
        throw new Error(`Run not found: ${runId}`);
      }

      if (run.consumed) {
        return;
      }

      run.consumed = true;
      run.status = "running";

      const rlog = createPipelineLogger("runtime", { runId });

      let executionContext = options.agentExecutionRepository
        ? await options.agentExecutionRepository.getExecutionContext(runId)
        : null;
      if (options.agentExecutionRepository && !executionContext) {
        throw new Error("run_not_active");
      }
      if (executionContext && options.agentExecutionRepository) {
        const attemptState =
          await options.agentExecutionRepository.getAttemptState(runId);
        const currentTime = new Date(now());
        if (
          attemptState?.status === "running" &&
          attemptState.leaseExpiresAt &&
          attemptState.leaseExpiresAt.getTime() <= currentTime.getTime()
        ) {
          if (!options.builtinSkillCatalog) {
            throw new Error("builtin_skill_catalog_required");
          }
          const authority = createAgentAuthority(PRODUCTION_AGENT_CAPABILITIES);
          const currentCapabilities = new Set<AgentCapability>(
            PRODUCTION_AGENT_CAPABILITIES,
          );
          const eligibleSkills = options.builtinSkillCatalog
            .list()
            .filter((skill) =>
              skill.requiredCapabilities.every((capability) =>
                currentCapabilities.has(capability),
              ),
            )
            .map((skill) => skill.name);
          executionContext =
            await options.agentExecutionRepository.resumeAttempt({
              runId,
              attemptId: randomUUID(),
              activeCatalogDigest: options.builtinSkillCatalog.digest,
              currentCapabilities: PRODUCTION_AGENT_CAPABILITIES,
              capabilityPolicyVersion: authority.policyVersion,
              effectiveSkillNames: eligibleSkills,
            });
        }
        const lease = await options.agentExecutionRepository.claimAttempt({
          attemptId: executionContext.attemptId,
          leaseOwner: `runtime-${randomUUID()}`,
          leaseMs: 15 * 60_000,
          now: new Date(now()),
        });
        run.attemptId = lease.attemptId;
        run.fencingToken = lease.fencingToken;
        executionContext =
          (await options.agentExecutionRepository.getExecutionContext(runId)) ??
          executionContext;
      }

      let persistence: Awaited<
        ReturnType<NonNullable<AgentPersistenceService["getPersistence"]>>
      > | null = null;
      const persistenceStartedAt = Date.now();
      try {
        await updatePersistedRunStatus(
          options.agentRunMetadataService,
          run,
          "running",
        );
        const persistenceService = options.agentPersistenceService;
        persistence =
          run.threadId && persistenceService
            ? await runWithDeadline({
                operation: () => persistenceService.getPersistence(),
                timeoutError: () =>
                  new AgentRunError({
                    code: "agent_persistence_timeout",
                    message: "Agent persistence initialization timed out.",
                    retryable: true,
                    statusCode: 504,
                  }),
                timeoutMs: persistenceTimeoutMs,
              })
            : null;
        rlog.info("agent.persistence.init.completed", {
          durationMs: Date.now() - persistenceStartedAt,
        });
        if (run.threadId && !persistence) {
          throw new Error(
            "SUPABASE_DB_URL is required for persisted agent threads.",
          );
        }
      } catch (error) {
        rlog.warn("agent.persistence.init.failed", {
          durationMs: Date.now() - persistenceStartedAt,
          errorCode: runtimeFailureCode(error),
          retryable: error instanceof AgentRunError && error.retryable,
        });
        yield await finalizeRuntimeFailure(
          options.agentExecutionRepository,
          run,
          now,
          error,
          options.finalizationRetryDelayMs,
        );
        return;
      }
      const canMutateCanvas =
        executionContext?.capabilities.includes("canvas.mutate") === true &&
        PRODUCTION_AGENT_CAPABILITIES.includes("canvas.mutate");

      // Build submitImageJob / submitVideoJob closures for async jobs via PGMQ
      let submitImageJob: SubmitImageJobFn | undefined;
      let submitVideoJob: SubmitVideoJobFn | undefined;
      if (
        options.jobService &&
        options.submitGeneration &&
        options.createUserClient &&
        run.accessToken &&
        run.userId
      ) {
        const jobSvc = options.jobService;
        const submitGeneration = options.submitGeneration;
        const createClient = options.createUserClient;
        const accessToken = run.accessToken;
        const userId = run.userId;
        const canvasId = run.canvasId;
        const sessionId = run.sessionId;
        const runId = run.runId;
        const resolveGenerationScope = createGenerationWorkspaceResolver({
          accessToken,
          ...(canvasId ? { canvasId } : {}),
          createUserClient: createClient,
        });

        submitImageJob = async (input) => {
          const jobT0 = Date.now();
          const jobLap = (label: string, extra?: Record<string, unknown>) => {
            console.log(
              `[submitImageJob] ${label} +${Date.now() - jobT0}ms`,
              extra ? JSON.stringify(extra) : "",
            );
          };

          const effect = await beginRuntimeEffect(
            options.agentExecutionRepository,
            run,
            input.logicalToolCallId,
            input,
          );
          if (effect?.status === "completed") {
            return effect.result as Awaited<ReturnType<SubmitImageJobFn>>;
          }
          const scope = await resolveGenerationScope();
          assertGenerationScope(executionContext, scope, canMutateCanvas);
          const { workspaceId } = scope;
          const attachment = canMutateCanvas
            ? createAgentAttachmentContext({
                run,
                effect,
                input,
                logicalToolCallId: input.logicalToolCallId,
                mediaType: "image",
              })
            : undefined;
          let submitted: Awaited<ReturnType<SubmitGeneration>>;
          try {
            submitted = await submitGenerationWithOptionalAttachment(
              submitGeneration,
              { userId, workspaceId, accessToken },
              {
                idempotency_key: agentGenerationKey(
                  runId,
                  "image",
                  input.logicalToolCallId,
                ),
                type: "image_generation",
                prompt: input.prompt,
                title: input.title,
                model: input.model,
                ...(input.quality ? { quality: input.quality } : {}),
                aspect_ratio: input.aspectRatio,
                ...(input.inputImages
                  ? { input_images: input.inputImages }
                  : {}),
                ...(canvasId ? { canvas_id: canvasId } : {}),
                ...(sessionId ? { session_id: sessionId } : {}),
                ...(attachment && scope.projectId
                  ? { project_id: scope.projectId }
                  : {}),
              },
              attachment,
            );
          } catch (error) {
            handleBillingSubmissionError(error, run);
            throw error;
          }
          const job = { id: submitted.jobId };
          jobLap("job_created", {
            jobId: job.id,
            sessionId,
            runId,
          });

          // Poll until terminal state
          // Worker image VT=120s, but Replicate calls can take 100s+ plus queue delay.
          const POLL_INTERVAL = 2000;
          const MAX_WAIT = 240_000; // 4 minutes
          const start = Date.now();
          let pollCount = 0;

          while (Date.now() - start < MAX_WAIT) {
            await delay(POLL_INTERVAL);
            pollCount++;

            if (run.controller.signal.aborted) {
              throw new Error("Run was canceled");
            }

            const current = await jobSvc.getJobAdmin(job.id);

            if (current.status === "succeeded" && current.result) {
              const result = current.result as {
                asset_id?: string;
                width?: number;
                height?: number;
                mime_type?: string;
              };
              jobLap("job_poll_done", { pollCount, status: "succeeded" });
              if (!result.asset_id) {
                throw new Error("generation_asset_id_missing");
              }
              const artifact = {
                type: "image" as const,
                title: input.title,
                url: `/api/assets/${result.asset_id}`,
                width: result.width ?? 1024,
                height: result.height ?? 1024,
                mimeType: result.mime_type ?? "image/png",
                jobId: job.id,
              };
              const completed =
                canMutateCanvas && canvasId
                  ? options.generatedAssetAttachments
                    ? {
                        ...(await options.generatedAssetAttachments.getStatus(
                          { userId, workspaceId, accessToken },
                          { canvasId, jobId: job.id },
                        )),
                        artifact,
                      }
                    : pendingAttachmentResult(job.id, canvasId, artifact)
                  : {
                      attachmentStatus: "not_requested" as const,
                      jobId: job.id,
                      artifact,
                    };
              await completeRuntimeEffect(
                options.agentExecutionRepository,
                run,
                input.logicalToolCallId,
                input,
                completed,
              );
              return completed;
            }

            if (
              current.status === "dead_letter" ||
              current.status === "canceled"
            ) {
              jobLap("job_poll_done", { pollCount, status: current.status });
              throw new Error(
                current.error_message ?? `Generation job ${current.status}`,
              );
            }

            // "failed" with attempts exhausted
            if (
              current.status === "failed" &&
              current.attempt_count >= current.max_attempts
            ) {
              jobLap("job_poll_done", {
                pollCount,
                status: "failed_max_retries",
              });
              throw new Error(
                current.error_message ?? "Generation job failed after retries",
              );
            }
          }

          jobLap("job_poll_done", { pollCount, status: "timeout" });
          throw new Error(`Generation job timed out after ${MAX_WAIT / 1000}s`);
        };

        submitVideoJob = async (input) => {
          const jobT0 = Date.now();
          const jobLap = (label: string, extra?: Record<string, unknown>) => {
            console.log(
              `[submitVideoJob] ${label} +${Date.now() - jobT0}ms`,
              extra ? JSON.stringify(extra) : "",
            );
          };

          const effect = await beginRuntimeEffect(
            options.agentExecutionRepository,
            run,
            input.logicalToolCallId,
            input,
          );
          if (effect?.status === "completed") {
            return effect.result as Awaited<ReturnType<SubmitVideoJobFn>>;
          }
          const scope = await resolveGenerationScope();
          assertGenerationScope(executionContext, scope, canMutateCanvas);
          const { workspaceId } = scope;
          const attachment = canMutateCanvas
            ? createAgentAttachmentContext({
                run,
                effect,
                input,
                logicalToolCallId: input.logicalToolCallId,
                mediaType: "video",
              })
            : undefined;
          let submitted: Awaited<ReturnType<SubmitGeneration>>;
          try {
            submitted = await submitGenerationWithOptionalAttachment(
              submitGeneration,
              { userId, workspaceId, accessToken },
              {
                idempotency_key: agentGenerationKey(
                  runId,
                  "video",
                  input.logicalToolCallId,
                ),
                type: "video_generation",
                prompt: input.prompt,
                model: input.model,
                ...(input.duration != null ? { duration: input.duration } : {}),
                ...(input.resolution ? { resolution: input.resolution } : {}),
                ...(input.aspectRatio
                  ? { aspect_ratio: input.aspectRatio }
                  : {}),
                ...(input.inputImages
                  ? { input_images: input.inputImages }
                  : {}),
                ...(input.inputVideo ? { input_video: input.inputVideo } : {}),
                ...(input.enableAudio != null
                  ? { enable_audio: input.enableAudio }
                  : {}),
                ...(canvasId ? { canvas_id: canvasId } : {}),
                ...(sessionId ? { session_id: sessionId } : {}),
                ...(attachment && scope.projectId
                  ? { project_id: scope.projectId }
                  : {}),
              },
              attachment,
            );
          } catch (error) {
            handleBillingSubmissionError(error, run);
            throw error;
          }
          const job = { id: submitted.jobId };
          jobLap("job_created", {
            jobId: job.id,
            sessionId,
            runId,
          });

          // Poll until terminal state — video generation is slower.
          // Google Vertex Veo can take 300-500s; 600s gives enough headroom
          // to avoid poll timeout while worker is still processing.
          const POLL_INTERVAL = 3000;
          const MAX_WAIT = 600_000; // 10 minutes
          const start = Date.now();
          let pollCount = 0;

          while (Date.now() - start < MAX_WAIT) {
            await delay(POLL_INTERVAL);
            pollCount++;

            if (run.controller.signal.aborted) {
              throw new Error("Run was canceled");
            }

            const current = await jobSvc.getJobAdmin(job.id);

            if (current.status === "succeeded" && current.result) {
              const result = current.result as {
                asset_id?: string;
                duration_seconds?: number;
                width?: number;
                height?: number;
                mime_type?: string;
              };
              jobLap("job_poll_done", { pollCount, status: "succeeded" });
              if (!result.asset_id) {
                throw new Error("generation_asset_id_missing");
              }
              const artifact = {
                type: "video" as const,
                url: `/api/assets/${result.asset_id}`,
                width: result.width ?? 1280,
                height: result.height ?? 720,
                mimeType: result.mime_type ?? "video/mp4",
                jobId: job.id,
                ...(result.duration_seconds != null
                  ? { durationSeconds: result.duration_seconds }
                  : {}),
              };
              const completed =
                canMutateCanvas && canvasId
                  ? options.generatedAssetAttachments
                    ? {
                        ...(await options.generatedAssetAttachments.getStatus(
                          { userId, workspaceId, accessToken },
                          { canvasId, jobId: job.id },
                        )),
                        artifact,
                      }
                    : pendingAttachmentResult(job.id, canvasId, artifact)
                  : {
                      attachmentStatus: "not_requested" as const,
                      jobId: job.id,
                      artifact,
                    };
              await completeRuntimeEffect(
                options.agentExecutionRepository,
                run,
                input.logicalToolCallId,
                input,
                completed,
              );
              return completed;
            }

            if (
              current.status === "dead_letter" ||
              current.status === "canceled"
            ) {
              jobLap("job_poll_done", { pollCount, status: current.status });
              throw new Error(
                current.error_message ?? `Generation job ${current.status}`,
              );
            }

            if (
              current.status === "failed" &&
              current.attempt_count >= current.max_attempts
            ) {
              jobLap("job_poll_done", {
                pollCount,
                status: "failed_max_retries",
              });
              throw new Error(
                current.error_message ?? "Generation job failed after retries",
              );
            }
          }

          jobLap("job_poll_done", { pollCount, status: "timeout" });
          throw new Error(`Generation job timed out after ${MAX_WAIT / 1000}s`);
        };
      }

      let agent: LoomicAgent;
      try {
        if (
          executionContext &&
          options.builtinSkillCatalog &&
          executionContext.skillCatalogDigest !==
            options.builtinSkillCatalog.digest
        ) {
          throw new Error("skill_catalog_changed");
        }
        const resolvedModel = run.modelOverride
          ? run.modelOverride.includes(":")
            ? run.modelOverride
            : createDefaultModelSpecifier({ agentModel: run.modelOverride })
          : options.model;

        // Resolve brand kit ID from canvas → project in a single joined query
        let brandKitId: string | null = null;
        if (run.canvasId && run.accessToken && options.createUserClient) {
          try {
            const client = options.createUserClient(run.accessToken) as any;
            const { data: canvas } = await client
              .from("canvases")
              .select("project_id, projects!inner(brand_kit_id)")
              .eq("id", run.canvasId)
              .maybeSingle();
            brandKitId = canvas?.projects?.brand_kit_id ?? null;
          } catch (err) {
            // Fallback: joined query may fail if FK isn't exposed via PostgREST
            // In that case, try the two-step approach
            try {
              const client = options.createUserClient(run.accessToken) as any;
              const { data: c } = await client
                .from("canvases")
                .select("project_id")
                .eq("id", run.canvasId)
                .maybeSingle();
              if (c?.project_id) {
                const { data: p } = await client
                  .from("projects")
                  .select("brand_kit_id")
                  .eq("id", c.project_id)
                  .maybeSingle();
                brandKitId = p?.brand_kit_id ?? null;
              }
            } catch (err2) {
              console.warn("Failed to resolve brand kit ID:", err2);
            }
          }
        }

        rlog.lap("brand_kit_resolved");

        agent = resolvedAgentFactory({
          ...(executionContext &&
          resolveCanvasScope &&
          run.accessToken &&
          run.userId
            ? {
                authorizeExecutionContext: async () => {
                  const scope = await resolveCanvasScope({
                    accessToken: run.accessToken!,
                    canvasId: executionContext.canvasId,
                  });
                  if (
                    scope.workspaceId !== executionContext.workspaceId ||
                    scope.projectId !== executionContext.projectId
                  ) {
                    throw new Error("canvas_access_denied");
                  }
                },
              }
            : {}),
          ...(options.applyCanvasOperations && resolveWorkspaceId
            ? {
                applyCanvasOperations: options.applyCanvasOperations,
                resolveWorkspaceId,
              }
            : {}),
          ...(brandKitId ? { brandKitId } : {}),
          ...(run.canvasId ? { canvasId: run.canvasId } : {}),
          ...(persistence ? { checkpointer: persistence.checkpointer } : {}),
          ...(options.connectionManager
            ? { connectionManager: options.connectionManager }
            : {}),
          env: options.env,
          providerRegistry: options.providerRegistry,
          ...(resolvedModel ? { model: resolvedModel } : {}),
          ...(submitImageJob ? { submitImageJob } : {}),
          ...(submitVideoJob ? { submitVideoJob } : {}),
          ...(persistence ? { store: persistence.store } : {}),
          ...(executionContext ? { executionContext } : {}),
          ...(run.fencingToken !== undefined
            ? { fencingToken: run.fencingToken }
            : {}),
          ...(options.builtinSkillCatalog
            ? { builtinSkillCatalog: options.builtinSkillCatalog }
            : {}),
          ...(options.agentExecutionRepository
            ? { agentExecutionRepository: options.agentExecutionRepository }
            : {}),
        });
        rlog.lap("agent_factory_done");
      } catch (error) {
        yield await finalizeRuntimeFailure(
          options.agentExecutionRepository,
          run,
          now,
          error,
          options.finalizationRetryDelayMs,
        );
        return;
      }

      let stream: AsyncIterable<unknown>;
      try {
        const hasAttachments = run.attachments && run.attachments.length > 0;
        let userMessage: HumanMessage;
        let attachmentDataMap: Record<string, string> = {};

        if (hasAttachments) {
          // Download images and build parallel data structures:
          // 1. imageBlocks: base64 content parts for LLM vision
          // 2. downloaded: assetId → base64 mapping for tool resolution
          const downloaded: Array<{
            assetId: string;
            mimeType: string;
            base64: string;
          }> = [];
          const imageBlocks = await Promise.all(
            run.attachments!.map(async (a) => {
              try {
                let b64: string;
                let mime: string;

                // Handle data URIs directly (canvas-ref images) — no fetch needed
                const dataUriMatch = a.url.match(/^data:([^;]+);base64,(.+)$/);
                if (dataUriMatch) {
                  mime = dataUriMatch[1]!;
                  b64 = dataUriMatch[2]!;
                } else {
                  const res = await fetch(a.url);
                  const buf = Buffer.from(await res.arrayBuffer());
                  mime =
                    a.mimeType ||
                    res.headers.get("content-type") ||
                    "image/png";
                  b64 = buf.toString("base64");
                }

                downloaded.push({
                  assetId: a.assetId,
                  mimeType: mime,
                  base64: b64,
                });
                // Use standard LangChain image_url format — works with both
                // Google Gemini and OpenAI adapters. The Anthropic-style
                // { type: "image", source_type: "base64" } format is NOT
                // recognized by @langchain/google-genai and gets serialized
                // as raw text, blowing past the token limit.
                return {
                  type: "image_url" as const,
                  image_url: `data:${mime};base64,${b64}`,
                };
              } catch {
                return {
                  type: "image_url" as const,
                  image_url: a.url,
                };
              }
            }),
          );

          // Build XML text tags for LLM to reference by assetId
          const { text: enrichedPrompt } = buildUserMessage(
            run.prompt,
            run.attachments!,
            run.imageGenerationPreference,
            run.mentions,
            run.videoGenerationPreference,
          );

          // Build assetId → data URI map for tool-level resolution
          attachmentDataMap = buildAttachmentDataMap(downloaded);

          userMessage = new HumanMessage({
            content: [
              { type: "text" as const, text: enrichedPrompt },
              ...imageBlocks,
            ],
          });
        } else {
          const { text: enrichedPrompt } = buildUserMessage(
            run.prompt,
            [],
            run.imageGenerationPreference,
            run.mentions,
            run.videoGenerationPreference,
          );
          userMessage = new HumanMessage(enrichedPrompt);
        }

        rlog.lap("stream_call_start");
        stream = agent.streamEvents(
          {
            messages: [userMessage],
          },
          {
            ...(run.threadId ||
            run.canvasId ||
            run.accessToken ||
            run.userId ||
            Object.keys(attachmentDataMap).length > 0
              ? {
                  configurable: {
                    ...(run.threadId ? { thread_id: run.threadId } : {}),
                    ...(run.canvasId ? { canvas_id: run.canvasId } : {}),
                    ...(run.accessToken
                      ? { access_token: run.accessToken }
                      : {}),
                    ...(run.userId ? { user_id: run.userId } : {}),
                    ...(Object.keys(attachmentDataMap).length > 0
                      ? { user_attachment_map: attachmentDataMap }
                      : {}),
                  },
                }
              : {}),
            signal: run.controller.signal,
            version: "v2",
          },
        );
        rlog.lap("stream_call_returned");
      } catch (error) {
        yield await finalizeRuntimeFailure(
          options.agentExecutionRepository,
          run,
          now,
          error,
          options.finalizationRetryDelayMs,
        );
        return;
      }

      const adaptedStream = adaptDeepAgentStream({
        conversationId: run.conversationId,
        now,
        runId,
        sessionId: run.sessionId,
        signal: run.controller.signal,
        stream,
        supervisor: agent.toolSupervisor,
      })[Symbol.asyncIterator]();
      let receivedModelEvent = false;
      const modelStartedAt = Date.now();
      try {
        while (true) {
          const next = receivedModelEvent
            ? await adaptedStream.next()
            : await runWithDeadline({
                operation: () => adaptedStream.next(),
                timeoutError: () =>
                  new AgentRunError({
                    code: "agent_first_event_timeout",
                    message: "Agent model did not produce an event in time.",
                    retryable: true,
                    statusCode: 504,
                  }),
                timeoutMs: firstEventTimeoutMs,
              });
          if (next.done) break;
          const event = next.value;
          if (event.type !== "run.started" && !receivedModelEvent) {
            receivedModelEvent = true;
            rlog.info("agent.model.first_event", {
              durationMs: Date.now() - modelStartedAt,
            });
          }
          if (
            options.agentExecutionRepository &&
            run.attemptId &&
            run.fencingToken !== undefined &&
            !(await options.agentExecutionRepository.isAttemptActive({
              attemptId: run.attemptId,
              fencingToken: run.fencingToken,
            }))
          ) {
            throw new Error("run_not_active");
          }
          if (isTerminalEvent(event)) {
            const abandoned =
              agent.toolSupervisor?.closeOpenCalls({
                code:
                  event.type === "run.failed"
                    ? event.error.code
                    : "run_terminated",
                correlationId: run.runId,
                message: "Tool execution ended before completion.",
              }) ?? [];
            for (const record of abandoned) {
              yield toPublicToolEvent(record);
              agent.toolSupervisor?.acknowledge(record);
            }
            const requestedStatus: AgentTerminalStatus =
              event.type === "run.completed"
                ? "completed"
                : event.type === "run.canceled"
                  ? "canceled"
                  : "failed";
            const finalizedStatus = await finalizeRuntimeRun(
              options.agentExecutionRepository,
              run,
              requestedStatus,
              terminalMetadata(event),
              options.finalizationRetryDelayMs,
            );
            run.status = finalizedStatus ?? requestedStatus;
            yield terminalEventForStatus(run, now, event);
            return;
          }
          run.status = "running";
          yield event;

          if (!isTerminalEvent(event) && options.eventDelayMs) {
            try {
              await delay(options.eventDelayMs, undefined, {
                signal: run.controller.signal,
              });
            } catch {
              const canceledEvent: Extract<
                StreamEvent,
                { type: "run.canceled" }
              > = {
                runId,
                timestamp: now(),
                type: "run.canceled",
              };
              const abandoned =
                agent.toolSupervisor?.closeOpenCalls({
                  code: "run_terminated",
                  correlationId: run.runId,
                  message: "Tool execution ended before completion.",
                }) ?? [];
              for (const record of abandoned) {
                yield toPublicToolEvent(record);
                agent.toolSupervisor?.acknowledge(record);
              }
              const finalized = await finalizeRuntimeRun(
                options.agentExecutionRepository,
                run,
                "canceled",
                {},
                options.finalizationRetryDelayMs,
              );
              run.status = finalized ?? "canceled";
              yield terminalEventForStatus(run, now, canceledEvent);
              return;
            }
          }
        }
      } catch (streamError) {
        if (streamError instanceof AgentFinalizationUnconfirmedError) {
          throw streamError;
        }
        if (streamError instanceof AgentRunError) {
          rlog.warn("agent.model.first_event.failed", {
            durationMs: Date.now() - modelStartedAt,
            errorCode: runtimeFailureCode(streamError),
            retryable: streamError.retryable,
          });
          run.controller.abort();
          void adaptedStream.return?.(undefined).catch(() => undefined);
        }
        // Catch DB / checkpoint errors that bubble up from the LangGraph stream
        // (e.g. Supabase circuit-breaker, connection pool exhaustion).
        // Instead of crashing the process, yield a clean failure event.
        console.error("[agent-runtime] Stream iteration failed:", streamError);
        const abandoned =
          agent.toolSupervisor?.closeOpenCalls({
            code: runtimeFailureCode(streamError),
            correlationId: run.runId,
            message: "Tool execution ended before completion.",
          }) ?? [];
        for (const record of abandoned) {
          yield toPublicToolEvent(record);
          agent.toolSupervisor?.acknowledge(record);
        }
        yield await finalizeRuntimeFailure(
          options.agentExecutionRepository,
          run,
          now,
          streamError,
          options.finalizationRetryDelayMs,
        );
        return;
      }
    },
  };
}

function pendingAttachmentResult<T extends Record<string, unknown>>(
  jobId: string,
  canvasId: string,
  artifact: T,
) {
  return {
    attachmentStatus: "pending" as const,
    jobId,
    artifact,
    recovery: {
      kind: "watch_generated_asset" as const,
      jobId,
      canvasId,
    },
    error: {
      code: "generated_asset_pending",
      message: "Generated media is still being attached to the canvas.",
      retryable: true,
    },
  };
}

function agentGenerationKey(
  runId: string,
  mediaType: "image" | "video",
  logicalToolCallId: string,
): string {
  const digest = createHash("sha256")
    .update(logicalToolCallId)
    .digest("hex")
    .slice(0, 32);
  return `agent:${runId}:${mediaType}:${digest}`.slice(0, 128);
}

async function beginRuntimeEffect(
  repository: AgentExecutionRepository | undefined,
  run: RuntimeRunRecord,
  logicalToolCallId: string,
  input: unknown,
) {
  if (!repository || !run.attemptId || run.fencingToken === undefined) {
    return null;
  }
  return repository.beginEffect({
    runId: run.runId,
    attemptId: run.attemptId,
    fencingToken: run.fencingToken,
    logicalToolCallId,
    inputDigest: runtimeInputDigest(input),
  });
}

async function completeRuntimeEffect(
  repository: AgentExecutionRepository | undefined,
  run: RuntimeRunRecord,
  logicalToolCallId: string,
  input: unknown,
  result: unknown,
): Promise<void> {
  if (!repository || !run.attemptId || run.fencingToken === undefined) return;
  await repository.completeEffect({
    runId: run.runId,
    attemptId: run.attemptId,
    fencingToken: run.fencingToken,
    logicalToolCallId,
    inputDigest: runtimeInputDigest(input),
    result,
  });
}

function runtimeInputDigest(input: unknown): string {
  return createHash("sha256").update(stableJson(input)).digest("hex");
}

function submitGenerationWithOptionalAttachment(
  submitGeneration: SubmitGeneration,
  principal: Parameters<SubmitGeneration>[0],
  request: unknown,
  attachment: AgentAttachmentContext | undefined,
): ReturnType<SubmitGeneration> {
  return attachment
    ? submitGeneration(principal, request, attachment)
    : submitGeneration(principal, request);
}

function createAgentAttachmentContext(options: {
  run: RuntimeRunRecord;
  effect: Awaited<ReturnType<typeof beginRuntimeEffect>>;
  input: unknown;
  logicalToolCallId: string;
  mediaType: "image" | "video";
}): AgentAttachmentContext {
  if (
    options.effect?.status !== "reserved" ||
    !options.run.attemptId ||
    options.run.fencingToken === undefined
  ) {
    throw attachmentInfrastructureUnavailable();
  }
  return {
    intentId: deterministicAttachmentIntentId(
      options.run.runId,
      options.mediaType,
      options.logicalToolCallId,
    ),
    runId: options.run.runId,
    attemptId: options.run.attemptId,
    fencingToken: options.run.fencingToken,
    logicalToolCallId: options.logicalToolCallId,
    inputDigest: runtimeInputDigest(options.input),
    effectKind: "generated_asset_attached",
    mediaType: options.mediaType,
    placement: attachmentPlacement(options.input, options.mediaType),
  };
}

function deterministicAttachmentIntentId(
  runId: string,
  mediaType: "image" | "video",
  logicalToolCallId: string,
): string {
  const bytes = createHash("sha256")
    .update(`${runId}:${mediaType}:${logicalToolCallId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function attachmentPlacement(
  input: unknown,
  mediaType: "image" | "video",
): AgentAttachmentPlacement {
  const placement = input as {
    placementX?: number;
    placementY?: number;
    placementWidth?: number;
    placementHeight?: number;
  };
  if (placement.placementX == null || placement.placementY == null) {
    return { kind: "auto_right" };
  }
  return {
    kind: "explicit",
    x: placement.placementX,
    y: placement.placementY,
    width: placement.placementWidth ?? (mediaType === "image" ? 512 : 640),
    height: placement.placementHeight ?? (mediaType === "image" ? 512 : 360),
  };
}

function assertGenerationScope(
  executionContext: Readonly<AgentExecutionContext> | null | undefined,
  scope: GenerationWorkspaceScope,
  requiresAttachment: boolean,
): void {
  if (!requiresAttachment) return;
  if (
    !scope.projectId ||
    !executionContext?.projectId ||
    scope.projectId !== executionContext.projectId ||
    scope.workspaceId !== executionContext.workspaceId
  ) {
    throw attachmentInfrastructureUnavailable();
  }
}

function attachmentInfrastructureUnavailable(): AppError {
  return new AppError({
    code: "application_error",
    statusCode: 503,
    message: "Generated asset attachment context is unavailable.",
    expose: false,
  });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isTerminalEvent(
  event: StreamEvent,
): event is Extract<
  StreamEvent,
  { type: "run.canceled" | "run.completed" | "run.failed" }
> {
  return (
    event.type === "run.canceled" ||
    event.type === "run.completed" ||
    event.type === "run.failed"
  );
}

function isBillingErrorCode(code: string): code is BillingErrorCode {
  return (
    code === "insufficient_credits" ||
    code === "model_not_accessible" ||
    code === "resolution_not_allowed" ||
    code === "concurrency_limit"
  );
}

function createGenerationWorkspaceResolver(options: {
  accessToken: string;
  canvasId?: string;
  createUserClient: (accessToken: string) => unknown;
}): () => Promise<GenerationWorkspaceScope> {
  let resolution: Promise<GenerationWorkspaceScope> | undefined;
  return () => {
    resolution ??= resolve();
    return resolution;
  };

  async function resolve(): Promise<GenerationWorkspaceScope> {
    const client = options.createUserClient(
      options.accessToken,
    ) as UserSupabaseClient;
    if (options.canvasId) {
      const { data, error } = await client
        .from("canvases")
        .select("id, project_id, projects!inner(workspace_id)")
        .eq("id", options.canvasId)
        .maybeSingle();
      const canvas = data as unknown as {
        id?: string;
        project_id?: string;
        projects?: { workspace_id?: string };
      } | null;
      const workspaceId = canvas?.projects?.workspace_id;
      if (
        error ||
        canvas?.id !== options.canvasId ||
        !canvas.project_id ||
        !workspaceId
      ) {
        throw new Error("Canvas not found or access denied");
      }
      return { projectId: canvas.project_id, workspaceId };
    }

    const { data, error } = await client
      .from("workspaces")
      .select("id")
      .eq("type", "personal")
      .limit(1)
      .single();
    if (error || !data?.id) throw new Error("No personal workspace found");
    return { workspaceId: data.id };
  }
}

type GenerationWorkspaceScope = {
  workspaceId: string;
  projectId?: string;
};

function isTerminalStatus(
  status: RuntimeRunStatus,
): status is AgentTerminalStatus {
  return status === "canceled" || status === "completed" || status === "failed";
}

async function finalizeRuntimeRun(
  repository: AgentExecutionRepository | undefined,
  run: RuntimeRunRecord,
  status: AgentTerminalStatus,
  metadata: Readonly<Record<string, unknown>>,
  retryDelayMs?: number,
): Promise<AgentTerminalStatus | null> {
  if (!repository || !run.attemptId || run.fencingToken === undefined) {
    return null;
  }
  const result = await finalizeAgentRun({
    repository,
    input: {
      runId: run.runId,
      attemptId: run.attemptId,
      fencingToken: run.fencingToken,
      status,
      metadata,
    },
    ...(retryDelayMs === undefined ? {} : { retryDelayMs }),
  });
  return result.status;
}

async function finalizeRuntimeFailure(
  repository: AgentExecutionRepository | undefined,
  run: RuntimeRunRecord,
  now: () => string,
  error: unknown,
  retryDelayMs?: number,
): Promise<StreamEvent> {
  const failedEvent = toFailedEvent(run.runId, now, error) as Extract<
    StreamEvent,
    { type: "run.failed" }
  >;
  const finalized = await finalizeRuntimeRun(
    repository,
    run,
    "failed",
    terminalMetadata(failedEvent),
    retryDelayMs,
  );
  run.status = finalized ?? "failed";
  return terminalEventForStatus(run, now, failedEvent);
}

function terminalMetadata(
  event: Extract<
    StreamEvent,
    { type: "run.canceled" | "run.completed" | "run.failed" }
  >,
): Readonly<Record<string, unknown>> {
  return event.type === "run.failed"
    ? { errorCode: event.error.code, errorMessage: event.error.message }
    : {};
}

function terminalEventForStatus(
  run: RuntimeRunRecord,
  now: () => string,
  requested: Extract<
    StreamEvent,
    { type: "run.canceled" | "run.completed" | "run.failed" }
  >,
): StreamEvent {
  if (run.status === "completed") {
    return { type: "run.completed", runId: run.runId, timestamp: now() };
  }
  if (run.status === "canceled") {
    return { type: "run.canceled", runId: run.runId, timestamp: now() };
  }
  return {
    type: "run.failed",
    runId: run.runId,
    timestamp: now(),
    error:
      requested.type === "run.failed"
        ? requested.error
        : {
            code: "run_failed",
            message: "Agent run failed.",
          },
  };
}

function toFailedEvent(
  runId: string,
  now: () => string,
  error: unknown,
): StreamEvent {
  // Log full error detail server-side
  console.error(`[runtime] Agent run failed for run ${runId}:`, error);

  return {
    error: {
      code: runtimeFailureCode(error),
      message: sanitizeErrorForClient(error),
    },
    runId,
    timestamp: now(),
    type: "run.failed",
  };
}

async function updatePersistedRunStatus(
  agentRunMetadataService: AgentRunMetadataService | undefined,
  run: RuntimeRunRecord,
  status: "running",
) {
  if (!agentRunMetadataService || !run.threadId) {
    return;
  }

  await agentRunMetadataService.updateRun({
    runId: run.runId,
    status,
  });
}

function runtimeFailureCode(
  error: unknown,
): "agent_first_event_timeout" | "agent_persistence_timeout" | "run_failed" {
  if (
    error instanceof AgentRunError &&
    (error.code === "agent_first_event_timeout" ||
      error.code === "agent_persistence_timeout")
  ) {
    return error.code;
  }
  return "run_failed";
}
