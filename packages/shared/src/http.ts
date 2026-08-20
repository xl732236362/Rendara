import { z } from "zod";
import { agentErrorCodeValues } from "./errors.js";

import {
  assetObjectSchema,
  canvasContentSchema,
  canvasDetailSchema,
  canvasRevisionSchema,
  chatMessageSchema,
  chatSessionSummarySchema,
  modelInfoSchema,
  projectIdSchema,
  projectSummarySchema,
  runIdSchema,
  viewerProfileSchema,
  workspaceMembershipSchema,
  workspaceSettingsSchema,
  workspaceSummarySchema,
} from "./contracts.js";

export const healthResponseSchema = z.object({
  ok: z.literal(true),
  service: z.literal("loomic-server"),
  version: z.string().min(1),
});

export const runCancelResponseSchema = z.object({
  runId: runIdSchema,
  status: z.enum(["canceling", "canceled"]),
});

export const viewerCreditsSchema = z.object({
  balance: z.number().int(),
  plan: z.string(),
  dailyClaimed: z.boolean(),
  limits: z.object({
    maxConcurrentJobs: z.number().int(),
    maxResolution: z.string(),
    monthlyCredits: z.number().int(),
    dailyCredits: z.number().int(),
  }),
});

export const viewerResponseSchema = z.object({
  profile: viewerProfileSchema,
  workspace: workspaceSummarySchema,
  membership: workspaceMembershipSchema,
  credits: viewerCreditsSchema.optional(),
});

export const projectListResponseSchema = z.object({
  projects: z.array(projectSummarySchema),
});

export const projectCreateRequestSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().min(1).optional(),
});

export const projectCreateResponseSchema = z.object({
  project: projectSummarySchema,
});

export const applicationErrorCodeSchema = z.enum([
  "capability_disabled",
  "application_error",
  "bootstrap_failed",
  "brand_kit_not_found",
  "brand_kit_create_failed",
  "brand_kit_update_failed",
  "brand_kit_delete_failed",
  "brand_kit_query_failed",
  "brand_kit_asset_not_found",
  "brand_kit_asset_create_failed",
  "canvas_not_found",
  "canvas_save_failed",
  "canvas_revision_conflict",
  "chat_error",
  "profile_update_failed",
  "project_query_failed",
  "project_create_failed",
  "project_delete_failed",
  "project_not_found",
  "project_slug_taken",
  "project_update_failed",
  "session_not_found",
  "settings_not_found",
  "settings_update_failed",
  "upload_failed",
  "asset_not_found",
  "job_not_found",
  "job_create_failed",
  "job_query_failed",
  "job_cancel_failed",
  "idempotency_conflict",
  "invalid_job_transition",
  "stale_job_lease",
  "job_already_terminal",
  "skill_not_found",
  "skill_create_failed",
  "skill_update_failed",
  "skill_delete_failed",
  "skill_query_failed",
  "skill_install_failed",
  "skill_uninstall_failed",
  "skill_toggle_failed",
  "skill_import_failed",
  "skill_file_query_failed",
  "marketplace_search_failed",
  "marketplace_detail_failed",
  "marketplace_install_failed",
  "insufficient_credits",
  "credit_query_failed",
  "credit_claim_failed",
  "credit_deduct_failed",
  "credit_refund_failed",
  "compensation_conflict",
  "credit_plan_update_failed",
  "model_not_accessible",
  "resolution_not_allowed",
  "concurrency_limit",
  "variant_not_found",
  "checkout_failed",
  "payment_not_configured",
  "subscription_not_found",
  "subscription_update_failed",
  "webhook_processing_failed",
  "generation_failed",
  ...agentErrorCodeValues,
]);

export const boundaryErrorCodeSchema = z.union([
  z.enum([
    "unauthorized",
    "forbidden",
    "invalid_request",
    "rate_limited",
    "request_aborted",
    "request_timeout",
    "unsafe_url",
    "response_too_large",
    "invalid_content_type",
    "upstream_error",
  ]),
  applicationErrorCodeSchema,
]);

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: boundaryErrorCodeSchema,
    message: z.string().min(1),
    correlationId: z.string().min(1).max(128).optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

export const unauthenticatedErrorResponseSchema = errorEnvelopeSchema.extend({
  error: errorEnvelopeSchema.shape.error.extend({
    code: z.literal("unauthorized"),
  }),
});

export const applicationErrorResponseSchema = errorEnvelopeSchema.extend({
  error: errorEnvelopeSchema.shape.error.extend({
    code: applicationErrorCodeSchema,
  }),
});

export const canvasGetResponseSchema = z.object({
  canvas: canvasDetailSchema,
});

export const canvasSaveRequestSchema = z.object({
  content: canvasContentSchema,
  expectedRevision: canvasRevisionSchema,
});

export const canvasSaveResponseSchema = z.object({
  ok: z.literal(true),
  revision: canvasRevisionSchema,
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type RunCancelResponse = z.infer<typeof runCancelResponseSchema>;
export type ViewerCredits = z.infer<typeof viewerCreditsSchema>;
export type ViewerResponse = z.infer<typeof viewerResponseSchema>;
export type ProjectListResponse = z.infer<typeof projectListResponseSchema>;
export type ProjectCreateRequest = z.infer<typeof projectCreateRequestSchema>;
export type ProjectCreateResponse = z.infer<typeof projectCreateResponseSchema>;
export type UnauthenticatedErrorResponse = z.infer<
  typeof unauthenticatedErrorResponseSchema
>;
export type ApplicationErrorCode = z.infer<typeof applicationErrorCodeSchema>;
export type BoundaryErrorCode = z.infer<typeof boundaryErrorCodeSchema>;
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
export type ApplicationErrorResponse = z.infer<
  typeof applicationErrorResponseSchema
>;
export const profileUpdateResponseSchema = z.object({
  profile: viewerProfileSchema,
});

export const workspaceSettingsResponseSchema = z.object({
  settings: workspaceSettingsSchema,
});

export const workspaceSettingsUpdateRequestSchema = workspaceSettingsSchema;

export const modelListResponseSchema = z.object({
  models: z.array(modelInfoSchema),
});

export const projectDetailResponseSchema = z.object({
  project: z
    .object({
      id: projectIdSchema,
      name: z.string().min(1),
      brand_kit_id: z.string().uuid().nullable(),
    })
    .passthrough(),
});

export const sessionTitleRequestSchema = z.object({
  title: z.string().trim().min(1).optional(),
});

export const generationModelInfoSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string(),
  provider: z.string().min(1),
  iconUrl: z.string().optional(),
  creditCost: z.number().optional(),
  accessible: z.boolean().optional(),
  minTier: z.string().optional(),
});

export const imageModelListResponseSchema = z.object({
  models: z.array(generationModelInfoSchema),
});

export const videoModelListResponseSchema = z.object({
  models: z.array(generationModelInfoSchema),
});

export const generateImageRequestSchema = z.object({
  prompt: z.string().min(1),
  model: z.string().optional(),
  aspectRatio: z.enum(["1:1", "16:9", "9:16", "4:3", "3:4"]).optional(),
  quality: z.enum(["standard", "hd", "ultra"]).optional(),
});

export const generateImageResponseSchema = z.object({
  url: z.string().url(),
  assetId: z.string().min(1).optional(),
  prompt: z.string(),
  mimeType: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export const generateVideoRequestSchema = z.object({
  prompt: z.string().min(1),
  model: z.string().optional(),
  duration: z.number().int().min(3).max(16).optional(),
  resolution: z.enum(["720p", "1080p", "4k"]).optional(),
  aspectRatio: z.enum(["16:9", "9:16"]).optional(),
  inputImages: z.array(z.string()).max(3).optional(),
});

export const generateVideoResponseSchema = z.object({
  url: z.string().url(),
  assetId: z.string().min(1),
  prompt: z.string(),
  mimeType: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  durationSeconds: z.number().positive(),
});

export const sessionListResponseSchema = z.object({
  sessions: z.array(chatSessionSummarySchema),
});

export const sessionCreateResponseSchema = z.object({
  session: chatSessionSummarySchema,
});

export const messageListResponseSchema = z.object({
  messages: z.array(chatMessageSchema),
});

export const messageCreateResponseSchema = z.object({
  message: chatMessageSchema,
});

export type SessionListResponse = z.infer<typeof sessionListResponseSchema>;
export type SessionCreateResponse = z.infer<typeof sessionCreateResponseSchema>;
export type MessageListResponse = z.infer<typeof messageListResponseSchema>;
export type MessageCreateResponse = z.infer<typeof messageCreateResponseSchema>;
export type CanvasGetResponse = z.infer<typeof canvasGetResponseSchema>;
export type CanvasSaveRequest = z.infer<typeof canvasSaveRequestSchema>;
export type CanvasSaveResponse = z.infer<typeof canvasSaveResponseSchema>;
export type ProfileUpdateResponse = z.infer<typeof profileUpdateResponseSchema>;
export type WorkspaceSettingsResponse = z.infer<
  typeof workspaceSettingsResponseSchema
>;
export type WorkspaceSettingsUpdateRequest = z.infer<
  typeof workspaceSettingsUpdateRequestSchema
>;
export type ModelListResponse = z.infer<typeof modelListResponseSchema>;
export type ProjectDetailResponse = z.infer<typeof projectDetailResponseSchema>;
export type SessionTitleRequest = z.infer<typeof sessionTitleRequestSchema>;
export type GenerationModelInfo = z.infer<typeof generationModelInfoSchema>;
export type ImageModelListResponse = z.infer<
  typeof imageModelListResponseSchema
>;
export type VideoModelListResponse = z.infer<
  typeof videoModelListResponseSchema
>;
export type GenerateImageRequest = z.infer<typeof generateImageRequestSchema>;
export type GenerateImageResponse = z.infer<typeof generateImageResponseSchema>;
export type GenerateVideoRequest = z.infer<typeof generateVideoRequestSchema>;
export type GenerateVideoResponse = z.infer<typeof generateVideoResponseSchema>;

export const uploadResponseSchema = z.object({
  asset: assetObjectSchema,
  url: z.string().min(1),
});

export const assetSignedUrlResponseSchema = z.object({
  url: z.string().min(1),
});

export type UploadResponse = z.infer<typeof uploadResponseSchema>;
export type AssetSignedUrlResponse = z.infer<
  typeof assetSignedUrlResponseSchema
>;

export const projectUpdateRequestSchema = z.object({
  brand_kit_id: z.string().uuid().nullable().optional(),
  name: z.string().min(1).max(100).optional(),
});
export type ProjectUpdateRequest = z.infer<typeof projectUpdateRequestSchema>;
