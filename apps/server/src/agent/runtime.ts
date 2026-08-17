// @credits-system — Agent tool runtime with credit checks before image/video generation
import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
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
import type { ApplyCanvasOperations } from "../application/canvas/apply-canvas-operations.js";
import type { AttachGeneratedAsset } from "../application/canvas/attach-generated-asset.js";
import type { SubmitGeneration } from "../application/generation/submit-generation.js";
import type { ServerEnv } from "../config/env.js";
import { AppError } from "../errors/app-error.js";
import type { AgentRunMetadataService } from "../features/agent-runs/agent-run-service.js";
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
import { createAgentBackend } from "./backends/index.js";
import {
  type LoomicAgent,
  type LoomicAgentFactory,
  createDefaultModelSpecifier,
  createLoomicDeepAgent,
} from "./deep-agent.js";
import type { AgentPersistenceService } from "./persistence/index.js";
import { adaptDeepAgentStream } from "./stream-adapter.js";
// execute 工具由 deepagents 内置提供（LocalShellBackend 作为 sandbox backend）
// 不需要自定义代码执行工具
import type { SubmitImageJobFn } from "./tools/image-generate.js";
import { buildCanvasSummaryForContext } from "./tools/inspect-canvas.js";
import type { SubmitVideoJobFn } from "./tools/video-generate.js";
import {
  type WorkspaceSkillEntry,
  loadWorkspaceSkills,
} from "./workspace-skills.js";

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
  canvasSummary?: string | null,
): { text: string } {
  const xmlBlocks: string[] = [];

  // Canvas state context (auto-injected, not user-provided)
  if (canvasSummary) {
    xmlBlocks.push(`<canvas_state>\n${canvasSummary}\n</canvas_state>`);
  }

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

  // Skill mentions — tell the agent to read and follow the mentioned skill
  const mentionedSkills = mentions.filter(
    (mention): mention is Extract<MessageMention, { mentionType: "skill" }> =>
      mention.mentionType === "skill",
  );
  if (mentionedSkills.length > 0) {
    const skillXml = mentionedSkills
      .map(
        (mention, i) =>
          `<skill index="${i + 1}" id="${escapeXmlAttribute(mention.id)}" name="${escapeXmlAttribute(mention.label)}" slug="${escapeXmlAttribute(mention.slug)}">\nThe user explicitly requested this skill. Read \`/workspace-skills/${mention.slug}/SKILL.md\` for full instructions and follow them.\n</skill>`,
      )
      .join("\n  ");
    xmlBlocks.push(
      `<human_skill_mentions count="${mentionedSkills.length}">\n  ${skillXml}\n</human_skill_mentions>`,
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
};

type CreateAgentRuntimeOptions = {
  agentPersistenceService?: AgentPersistenceService;
  applyCanvasOperations?: ApplyCanvasOperations;
  attachGeneratedAsset?: AttachGeneratedAsset;
  agentFactory?: LoomicAgentFactory;
  agentRunMetadataService?: AgentRunMetadataService;
  connectionManager?: ConnectionManager;
  createUserClient?: (accessToken: string) => unknown;
  creditService?: CreditService;
  env: ServerEnv;
  eventDelayMs?: number;
  jobService?: JobService;
  model?: BaseLanguageModel | string;
  providerRegistry: ProviderCatalog;
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
  const createUserClientForCanvas = options.createUserClient;
  const resolveWorkspaceId =
    options.applyCanvasOperations && createUserClientForCanvas
      ? async (context: {
          accessToken: string;
          userId: string;
          canvasId: string;
        }) => {
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
            projects?: { workspace_id?: string };
          } | null;
          const workspaceId = canvas?.projects?.workspace_id;
          if (error || canvas?.id !== context.canvasId || !workspaceId) {
            throw new Error("Canvas not found or access denied");
          }
          return workspaceId;
        }
      : undefined;

  const resolvedAgentFactory: LoomicAgentFactory =
    options.agentFactory ??
    ((agentOptions) =>
      createLoomicDeepAgent({
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

  return {
    cancelRun(runId: string): RunCancelResponse | null {
      const run = runs.get(runId);
      if (!run) {
        return null;
      }

      if (!run.controller.signal.aborted) {
        run.controller.abort();
      }

      run.status = "canceled";
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
        threadId?: string;
        userId?: string;
      },
    ): RunCreateResponse {
      const runId = runIdFactory();
      const { accessToken: _ignoredAccessToken, ...runInput } = input;

      runs.set(runId, {
        ...runInput,
        ...(runOptions?.accessToken
          ? { accessToken: runOptions.accessToken }
          : {}),
        consumed: false,
        controller: new AbortController(),
        ...(runOptions?.model ? { modelOverride: runOptions.model } : {}),
        ...(runOptions?.threadId ? { threadId: runOptions.threadId } : {}),
        ...(runOptions?.userId ? { userId: runOptions.userId } : {}),
        runId,
        status: "accepted",
      });

      return {
        conversationId: input.conversationId,
        runId,
        sessionId: input.sessionId,
        status: "accepted",
      };
    },

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

      try {
        await updatePersistedRunStatus(
          options.agentRunMetadataService,
          run,
          "running",
        );
      } catch (error) {
        const failedEvent = toFailedEvent(runId, now, error);
        run.status = "failed";
        yield failedEvent;
        return;
      }

      let persistence: Awaited<
        ReturnType<NonNullable<AgentPersistenceService["getPersistence"]>>
      > | null = null;
      try {
        persistence =
          run.threadId && options.agentPersistenceService
            ? await options.agentPersistenceService.getPersistence()
            : null;
        rlog.lap("persistence_init");
      } catch (error) {
        const failedEvent = toFailedEvent(runId, now, error);
        run.status = "failed";
        await updatePersistedRunFailure(
          options.agentRunMetadataService,
          run,
          now,
          error,
        );
        yield failedEvent;
        return;
      }

      if (run.threadId && !persistence) {
        const failedEvent = toFailedEvent(
          runId,
          now,
          new Error("SUPABASE_DB_URL is required for persisted agent threads."),
        );
        run.status = "failed";
        await updatePersistedRunFailure(
          options.agentRunMetadataService,
          run,
          now,
          new Error("SUPABASE_DB_URL is required for persisted agent threads."),
        );
        yield failedEvent;
        return;
      }

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
        const resolveGenerationWorkspaceId = createGenerationWorkspaceResolver({
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

          const workspaceId = await resolveGenerationWorkspaceId();
          let submitted: Awaited<ReturnType<SubmitGeneration>>;
          try {
            submitted = await submitGeneration(
              { userId, workspaceId, accessToken },
              {
                idempotency_key: agentGenerationKey(runId, "image", input),
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
              },
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
                signed_url?: string;
                object_path?: string;
                width?: number;
                height?: number;
                mime_type?: string;
              };
              jobLap("job_poll_done", { pollCount, status: "succeeded" });

              // Write element directly to canvas (backend-driven insertion)
              let elementId: string | undefined;
              if (
                canvasId &&
                result.object_path &&
                options.attachGeneratedAsset
              ) {
                try {
                  const placementInput = input as typeof input & {
                    placementX?: number;
                    placementY?: number;
                    placementWidth?: number;
                    placementHeight?: number;
                  };
                  const explicitPlacement =
                    placementInput.placementX != null &&
                    placementInput.placementY != null
                      ? {
                          x: placementInput.placementX,
                          y: placementInput.placementY,
                          width: placementInput.placementWidth ?? 512,
                          height: placementInput.placementHeight ?? 512,
                        }
                      : undefined;
                  const insertResult = await options.attachGeneratedAsset(
                    { userId, workspaceId, accessToken },
                    {
                      canvasId,
                      asset: {
                        type: "image",
                        objectPath: result.object_path,
                        width: result.width ?? 1024,
                        height: result.height ?? 1024,
                        mimeType: result.mime_type ?? "image/png",
                        title: input.title,
                      },
                      ...(explicitPlacement
                        ? { placement: explicitPlacement }
                        : {}),
                    },
                  );
                  elementId = insertResult.elementId;

                  // Notify connected frontends to refresh canvas
                  options.connectionManager?.pushToCanvas(canvasId, {
                    type: "canvas.sync" as const,
                    runId,
                    timestamp: new Date().toISOString(),
                  });
                  jobLap("canvas_element_inserted", { elementId });
                } catch (insertErr) {
                  // Graceful degradation: log error but still return result
                  console.error(
                    "[submitImageJob] canvas insert failed:",
                    insertErr,
                  );
                }
              }

              return {
                jobId: job.id,
                ...(elementId != null ? { elementId } : {}),
                imageUrl: result.signed_url ?? "",
                width: result.width ?? 1024,
                height: result.height ?? 1024,
                mimeType: result.mime_type ?? "image/png",
              };
            }

            if (
              current.status === "dead_letter" ||
              current.status === "canceled"
            ) {
              jobLap("job_poll_done", { pollCount, status: current.status });
              return {
                jobId: job.id,
                error: current.error_message ?? `Job ${current.status}`,
              };
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
              return {
                jobId: job.id,
                error: current.error_message ?? "Job failed after max retries",
              };
            }
          }

          jobLap("job_poll_done", { pollCount, status: "timeout" });
          return {
            jobId: job.id,
            error: `Job timed out after ${MAX_WAIT / 1000}s`,
          };
        };

        submitVideoJob = async (input) => {
          const jobT0 = Date.now();
          const jobLap = (label: string, extra?: Record<string, unknown>) => {
            console.log(
              `[submitVideoJob] ${label} +${Date.now() - jobT0}ms`,
              extra ? JSON.stringify(extra) : "",
            );
          };

          const workspaceId = await resolveGenerationWorkspaceId();
          let submitted: Awaited<ReturnType<SubmitGeneration>>;
          try {
            submitted = await submitGeneration(
              { userId, workspaceId, accessToken },
              {
                idempotency_key: agentGenerationKey(runId, "video", input),
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
              },
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
                signed_url?: string;
                duration_seconds?: number;
                width?: number;
                height?: number;
                mime_type?: string;
              };
              jobLap("job_poll_done", { pollCount, status: "succeeded" });

              // Write element directly to canvas (backend-driven insertion)
              let elementId: string | undefined;
              if (
                canvasId &&
                result.signed_url &&
                options.attachGeneratedAsset
              ) {
                try {
                  const placementInput = input as typeof input & {
                    placementX?: number;
                    placementY?: number;
                    placementWidth?: number;
                    placementHeight?: number;
                  };
                  const explicitPlacement =
                    placementInput.placementX != null &&
                    placementInput.placementY != null
                      ? {
                          x: placementInput.placementX,
                          y: placementInput.placementY,
                          width: placementInput.placementWidth ?? 640,
                          height: placementInput.placementHeight ?? 360,
                        }
                      : undefined;
                  const insertResult = await options.attachGeneratedAsset(
                    { userId, workspaceId, accessToken },
                    {
                      canvasId,
                      asset: {
                        type: "video",
                        signedUrl: result.signed_url,
                        width: result.width ?? 1280,
                        height: result.height ?? 720,
                        mimeType: result.mime_type ?? "video/mp4",
                        ...(result.duration_seconds != null
                          ? { durationSeconds: result.duration_seconds }
                          : {}),
                      },
                      ...(explicitPlacement
                        ? { placement: explicitPlacement }
                        : {}),
                    },
                  );
                  elementId = insertResult.elementId;

                  // Notify connected frontends to refresh canvas
                  options.connectionManager?.pushToCanvas(canvasId, {
                    type: "canvas.sync" as const,
                    runId,
                    timestamp: new Date().toISOString(),
                  });
                  jobLap("canvas_element_inserted", { elementId });
                } catch (insertErr) {
                  // Graceful degradation: log error but still return result
                  console.error(
                    "[submitVideoJob] canvas insert failed:",
                    insertErr,
                  );
                }
              }

              return {
                jobId: job.id,
                ...(elementId != null ? { elementId } : {}),
                videoUrl: result.signed_url ?? "",
                width: result.width ?? 1280,
                height: result.height ?? 720,
                mimeType: result.mime_type ?? "video/mp4",
                ...(result.duration_seconds != null
                  ? { durationSeconds: result.duration_seconds }
                  : {}),
              };
            }

            if (
              current.status === "dead_letter" ||
              current.status === "canceled"
            ) {
              jobLap("job_poll_done", { pollCount, status: current.status });
              return {
                jobId: job.id,
                error: current.error_message ?? `Job ${current.status}`,
              };
            }

            if (
              current.status === "failed" &&
              current.attempt_count >= current.max_attempts
            ) {
              jobLap("job_poll_done", {
                pollCount,
                status: "failed_max_retries",
              });
              return {
                jobId: job.id,
                error: current.error_message ?? "Job failed after max retries",
              };
            }
          }

          jobLap("job_poll_done", { pollCount, status: "timeout" });
          return {
            jobId: job.id,
            error: `Job timed out after ${MAX_WAIT / 1000}s`,
          };
        };
      }

      // Load workspace skills (user-installed skills from DB).
      // Done before backend creation so we know whether to add the
      // /workspace-skills/ Store route.
      let workspaceSkills: WorkspaceSkillEntry[] = [];
      if (run.canvasId && run.accessToken && options.createUserClient) {
        try {
          const wsClient = options.createUserClient(
            run.accessToken,
          ) as UserSupabaseClient;
          workspaceSkills = await loadWorkspaceSkills(wsClient, run.canvasId);
          rlog.lap("workspace_skills_loaded", {
            count: workspaceSkills.length,
          });
        } catch (err) {
          // Non-fatal: agent runs without workspace skills
          console.warn("[runtime] Failed to load workspace skills:", err);
        }
      }

      // Create backend — production uses StateBackend (no local shell).
      const backendResult = createAgentBackend(options.env, run.canvasId, {
        hasWorkspaceSkills: workspaceSkills.length > 0,
      });

      try {
        let agent: LoomicAgent;
        try {
          const resolvedModel = run.modelOverride
            ? run.modelOverride.includes(":")
              ? run.modelOverride
              : createDefaultModelSpecifier({ agentModel: run.modelOverride })
            : options.model;

          // Build persistImage closure using the user's Supabase client.
          // Client creation is deferred into the closure so it only runs
          // when an image is actually generated (avoids throwing in tests
          // that don't configure Supabase env vars).
          let persistImage:
            | ((url: string, mime: string, prompt: string) => Promise<string>)
            | undefined;
          if (options.createUserClient && run.accessToken) {
            const createClient = options.createUserClient;
            const accessToken = run.accessToken;
            persistImage = async (sourceUrl, mimeType, prompt) => {
              const client = createClient(accessToken) as UserSupabaseClient;
              const response = await fetch(sourceUrl);
              if (!response.ok)
                throw new Error(`Download failed: ${response.status}`);
              const buffer = Buffer.from(await response.arrayBuffer());
              const ext = mimeType === "image/webp" ? "webp" : "png";
              const slug = prompt
                .slice(0, 40)
                .replace(/[^a-zA-Z0-9]+/g, "-")
                .replace(/^-|-$/g, "");
              const fileName = `gen-${slug}-${Date.now()}.${ext}`;

              const { data: ws } = await client
                .from("workspaces")
                .select("id")
                .eq("type", "personal")
                .limit(1)
                .single();
              const workspaceId = ws?.id ?? "default";
              const objectPath = `${workspaceId}/${Date.now()}-${fileName}`;

              const { error: uploadError } = await client.storage
                .from("project-assets")
                .upload(objectPath, buffer, {
                  contentType: mimeType,
                  upsert: false,
                });
              if (uploadError)
                throw new Error(`Upload failed: ${uploadError.message}`);

              const { data: urlData } = client.storage
                .from("project-assets")
                .getPublicUrl(objectPath);

              return urlData.publicUrl;
            };
          }

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

          // Pre-write workspace skill SKILL.md files AND associated files
          // (scripts/, references/, assets/) into the Store so the agent can
          // read_file them via the /workspace-skills/ route.
          const store = persistence?.store;
          if (workspaceSkills.length > 0 && store && run.canvasId) {
            const storeNamespace = [
              "projects",
              run.canvasId,
              "workspace-skills",
            ];
            const now_ = new Date().toISOString();

            const writeOps: Promise<void>[] = [];
            for (const skill of workspaceSkills) {
              // Write SKILL.md
              writeOps.push(
                store.put(storeNamespace, `/${skill.name}/SKILL.md`, {
                  content: skill.content.split("\n"),
                  created_at: now_,
                  modified_at: now_,
                }),
              );
              // Write associated files (scripts/, references/, assets/)
              for (const file of skill.files) {
                writeOps.push(
                  store.put(storeNamespace, `/${skill.name}/${file.path}`, {
                    content: file.content.split("\n"),
                    created_at: now_,
                    modified_at: now_,
                  }),
                );
              }
            }

            await Promise.all(writeOps);
            const totalFiles = workspaceSkills.reduce(
              (sum, s) => sum + s.files.length,
              0,
            );
            rlog.lap("workspace_skills_stored", {
              count: workspaceSkills.length,
              files: totalFiles,
            });
          }

          agent = resolvedAgentFactory({
            ...(options.applyCanvasOperations && resolveWorkspaceId
              ? {
                  applyCanvasOperations: options.applyCanvasOperations,
                  resolveWorkspaceId,
                }
              : {}),
            backendResult,
            ...(brandKitId ? { brandKitId } : {}),
            ...(run.canvasId ? { canvasId: run.canvasId } : {}),
            ...(persistence ? { checkpointer: persistence.checkpointer } : {}),
            ...(options.connectionManager
              ? { connectionManager: options.connectionManager }
              : {}),
            env: options.env,
            providerRegistry: options.providerRegistry,
            ...(resolvedModel ? { model: resolvedModel } : {}),
            ...(persistImage ? { persistImage } : {}),
            // execute 工具由 LocalShellBackend 自动提供，无需手动传递
            ...(submitImageJob ? { submitImageJob } : {}),
            ...(submitVideoJob ? { submitVideoJob } : {}),
            ...(persistence ? { store: persistence.store } : {}),
            ...(workspaceSkills.length > 0 ? { workspaceSkills } : {}),
          });
          rlog.lap("agent_factory_done");
        } catch (error) {
          const failedEvent = toFailedEvent(runId, now, error);
          run.status = "failed";
          await updatePersistedRunFailure(
            options.agentRunMetadataService,
            run,
            now,
            error,
          );
          yield failedEvent;
          return;
        }

        let stream: AsyncIterable<unknown>;
        try {
          // Auto-inject canvas state summary so the agent has immediate awareness
          // of what's on the canvas without needing to call inspect_canvas first.
          let canvasSummary: string | null = null;
          if (run.canvasId && run.accessToken && options.createUserClient) {
            try {
              const canvasClient = options.createUserClient(
                run.accessToken,
              ) as any;
              const { data: canvasData } = await canvasClient
                .from("canvases")
                .select("content")
                .eq("id", run.canvasId)
                .single();
              if (canvasData?.content?.elements) {
                canvasSummary = buildCanvasSummaryForContext(
                  canvasData.content.elements as Array<Record<string, unknown>>,
                );
              }
            } catch {
              // Non-critical — agent can still call inspect_canvas manually
            }
          }

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
                  const dataUriMatch = a.url.match(
                    /^data:([^;]+);base64,(.+)$/,
                  );
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
              canvasSummary,
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
              canvasSummary,
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
          const failedEvent = toFailedEvent(runId, now, error);
          run.status = "failed";
          await updatePersistedRunFailure(
            options.agentRunMetadataService,
            run,
            now,
            error,
          );
          yield failedEvent;
          return;
        }

        try {
          for await (const event of adaptDeepAgentStream({
            conversationId: run.conversationId,
            now,
            runId,
            sessionId: run.sessionId,
            signal: run.controller.signal,
            stream,
          })) {
            run.status = mapEventToStatus(event);
            try {
              await syncPersistedRunFromEvent(
                options.agentRunMetadataService,
                run,
                event,
                now,
              );
            } catch (error) {
              const failedEvent = toFailedEvent(runId, now, error);
              run.status = "failed";
              yield failedEvent;
              return;
            }
            yield event;

            if (!isTerminalEvent(event) && options.eventDelayMs) {
              try {
                await delay(options.eventDelayMs, undefined, {
                  signal: run.controller.signal,
                });
              } catch {
                run.status = "canceled";
                yield {
                  runId,
                  timestamp: now(),
                  type: "run.canceled",
                };
                return;
              }
            }
          }
        } catch (streamError) {
          // Catch DB / checkpoint errors that bubble up from the LangGraph stream
          // (e.g. Supabase circuit-breaker, connection pool exhaustion).
          // Instead of crashing the process, yield a clean failure event.
          console.error(
            "[agent-runtime] Stream iteration failed:",
            streamError,
          );
          const failedEvent = toFailedEvent(runId, now, streamError);
          run.status = "failed";
          await updatePersistedRunFailure(
            options.agentRunMetadataService,
            run,
            now,
            streamError,
          ).catch((persistErr) =>
            console.error(
              "[agent-runtime] Failed to persist run failure:",
              persistErr,
            ),
          );
          yield failedEvent;
          return;
        }
      } finally {
        if (backendResult.sandboxDir) {
          rm(backendResult.sandboxDir, { recursive: true, force: true }).catch(
            (err) => console.warn("[sandbox] cleanup failed:", err.message),
          );
        }
      }
    },
  };
}

function agentGenerationKey(
  runId: string,
  mediaType: "image" | "video",
  input: unknown,
): string {
  const digest = createHash("sha256")
    .update(stableJson(input))
    .digest("hex")
    .slice(0, 32);
  return `agent:${runId}:${mediaType}:${digest}`.slice(0, 128);
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

function isTerminalEvent(event: StreamEvent) {
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
}): () => Promise<string> {
  let resolution: Promise<string> | undefined;
  return () => {
    resolution ??= resolve();
    return resolution;
  };

  async function resolve(): Promise<string> {
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
        projects?: { workspace_id?: string };
      } | null;
      const workspaceId = canvas?.projects?.workspace_id;
      if (error || canvas?.id !== options.canvasId || !workspaceId) {
        throw new Error("Canvas not found or access denied");
      }
      return workspaceId;
    }

    const { data, error } = await client
      .from("workspaces")
      .select("id")
      .eq("type", "personal")
      .limit(1)
      .single();
    if (error || !data?.id) throw new Error("No personal workspace found");
    return data.id;
  }
}

function mapEventToStatus(event: StreamEvent): RuntimeRunStatus {
  switch (event.type) {
    case "run.canceled":
      return "canceled";
    case "run.completed":
      return "completed";
    case "run.failed":
      return "failed";
    default:
      return "running";
  }
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
      code: "run_failed",
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
  status: "running" | "completed",
  options?: {
    completedAt?: string;
  },
) {
  if (!agentRunMetadataService || !run.threadId) {
    return;
  }

  await agentRunMetadataService.updateRun({
    ...(options?.completedAt ? { completedAt: options.completedAt } : {}),
    runId: run.runId,
    status,
  });
}

async function updatePersistedRunFailure(
  agentRunMetadataService: AgentRunMetadataService | undefined,
  run: RuntimeRunRecord,
  now: () => string,
  error: unknown,
) {
  if (!agentRunMetadataService || !run.threadId) {
    return;
  }

  await agentRunMetadataService.updateRun({
    completedAt: now(),
    errorCode: "run_failed",
    errorMessage:
      error instanceof Error ? error.message : "Deep agent runtime failed.",
    runId: run.runId,
    status: "failed",
  });
}

async function syncPersistedRunFromEvent(
  agentRunMetadataService: AgentRunMetadataService | undefined,
  run: RuntimeRunRecord,
  event: StreamEvent,
  now: () => string,
) {
  if (event.type === "run.completed") {
    await updatePersistedRunStatus(agentRunMetadataService, run, "completed", {
      completedAt: now(),
    });
    return;
  }

  if (event.type === "run.failed") {
    await updatePersistedRunFailure(
      agentRunMetadataService,
      run,
      now,
      new Error(event.error.message),
    );
  }
}
