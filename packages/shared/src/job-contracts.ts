import { z } from "zod";

// --- Enums ---

export const backgroundJobStatusSchema = z.enum([
  "queued",
  "running",
  "cancel_requested",
  "succeeded",
  "failed",
  "canceled",
  "dead_letter",
]);
export type BackgroundJobStatus = z.infer<typeof backgroundJobStatusSchema>;

export const backgroundJobTypeSchema = z.enum([
  "image_generation",
  "video_generation",
]);
export type BackgroundJobType = z.infer<typeof backgroundJobTypeSchema>;

// --- Payloads ---

export const imageGenerationPayloadSchema = z.object({
  prompt: z.string().min(1),
  title: z.string().min(1).optional(),
  model: z.string().optional(),
  aspect_ratio: z.string().optional(),
  input_images: z.array(z.string()).optional(),
  quality: z.enum(["standard", "hd", "ultra"]).optional(),
});
export type ImageGenerationPayload = z.infer<
  typeof imageGenerationPayloadSchema
>;

export const videoGenerationPayloadSchema = z.object({
  prompt: z.string().min(1),
  model: z.string().optional(),
  duration: z.number().int().optional(),
  resolution: z.string().optional(),
  aspect_ratio: z.string().optional(),
  input_images: z.array(z.string()).optional(),
  input_video: z.string().optional(),
  enable_audio: z.boolean().optional(),
});
export type VideoGenerationPayload = z.infer<
  typeof videoGenerationPayloadSchema
>;

const generationRequestContextShape = {
  project_id: z.string().uuid().optional(),
  canvas_id: z.string().uuid().optional(),
  session_id: z.string().uuid().optional(),
  thread_id: z.string().optional(),
};

export const idempotencyKeySchema = z.string().trim().min(1).max(128);

const generationSubmissionIdentityShape = {
  idempotency_key: idempotencyKeySchema,
};

export const generationSubmissionRequestSchema = z.discriminatedUnion("type", [
  imageGenerationPayloadSchema
    .extend({
      ...generationRequestContextShape,
      ...generationSubmissionIdentityShape,
      type: z.literal("image_generation"),
    })
    .strict(),
  videoGenerationPayloadSchema
    .extend({
      ...generationRequestContextShape,
      ...generationSubmissionIdentityShape,
      type: z.literal("video_generation"),
    })
    .strict(),
]);
export type GenerationSubmissionRequest = z.infer<
  typeof generationSubmissionRequestSchema
>;

export const generationSubmissionResponseSchema = z.object({
  jobId: z.string().uuid(),
  status: z.literal("queued"),
});
export type GenerationSubmissionResponse = z.infer<
  typeof generationSubmissionResponseSchema
>;

export const generationCancellationRequestSchema = z.object({
  jobId: z.string().uuid(),
});
export type GenerationCancellationRequest = z.infer<
  typeof generationCancellationRequestSchema
>;

export const generationCancellationResponseSchema = z.object({
  jobId: z.string().uuid(),
  status: z.enum(["canceling", "canceled"]),
});
export type GenerationCancellationResponse = z.infer<
  typeof generationCancellationResponseSchema
>;

export const generationQueueEnvelopeSchema = z.discriminatedUnion("type", [
  z.object({
    job_id: z.string().uuid().optional(),
    job_type: z.literal("image_generation").optional(),
    workspace_id: z.string().uuid().optional(),
    ...generationRequestContextShape,
    schemaVersion: z.literal(1),
    type: z.literal("image_generation"),
    payload: imageGenerationPayloadSchema
      .extend({
        job_id: z.string().uuid(),
        workspace_id: z.string().uuid(),
        ...generationRequestContextShape,
      })
      .strict(),
  }),
  z.object({
    job_id: z.string().uuid().optional(),
    job_type: z.literal("video_generation").optional(),
    workspace_id: z.string().uuid().optional(),
    ...generationRequestContextShape,
    schemaVersion: z.literal(1),
    type: z.literal("video_generation"),
    payload: videoGenerationPayloadSchema
      .extend({
        job_id: z.string().uuid(),
        workspace_id: z.string().uuid(),
        ...generationRequestContextShape,
      })
      .strict(),
  }),
]);
export type GenerationQueueEnvelope = z.infer<
  typeof generationQueueEnvelopeSchema
>;

export const createVideoJobRequestSchema = z.object({
  idempotency_key: idempotencyKeySchema,
  project_id: z.string().uuid().optional(),
  canvas_id: z.string().uuid().optional(),
  session_id: z.string().uuid().optional(),
  thread_id: z.string().optional(),
  prompt: z.string().min(1),
  model: z.string().optional(),
  duration: z.number().int().optional(),
  resolution: z.string().optional(),
  aspect_ratio: z.string().optional(),
  input_images: z.array(z.string()).optional(),
  input_video: z.string().optional(),
  enable_audio: z.boolean().optional(),
});
export type CreateVideoJobRequest = z.infer<typeof createVideoJobRequestSchema>;

// --- Job entity ---

export const backgroundJobSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  project_id: z.string().uuid().nullable(),
  canvas_id: z.string().uuid().nullable(),
  session_id: z.string().uuid().nullable(),
  thread_id: z.string().nullable(),
  queue_name: z.string(),
  job_type: backgroundJobTypeSchema,
  status: backgroundJobStatusSchema,
  payload: z.record(z.string(), z.unknown()),
  result: z.record(z.string(), z.unknown()).nullable(),
  error_code: z.string().nullable(),
  error_message: z.string().nullable(),
  attempt_count: z.number().int(),
  max_attempts: z.number().int(),
  transition_version: z.number().int().nonnegative(),
  lease_token: z.string().uuid().nullable(),
  lease_owner: z.string().nullable(),
  lease_expires_at: z.string().nullable(),
  pgmq_message_id: z.number().int().nonnegative().nullable(),
  credits_transaction_id: z.string().uuid().nullable(),
  credits_cost: z.number().int().nonnegative().nullable(),
  created_by: z.string().uuid(),
  created_at: z.string(),
  updated_at: z.string(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  failed_at: z.string().nullable(),
  canceled_at: z.string().nullable(),
});
export type BackgroundJob = z.infer<typeof backgroundJobSchema>;

// --- API Request schemas ---

export const createImageJobRequestSchema = z.object({
  idempotency_key: idempotencyKeySchema,
  project_id: z.string().uuid().optional(),
  canvas_id: z.string().uuid().optional(),
  session_id: z.string().uuid().optional(),
  thread_id: z.string().optional(),
  prompt: z.string().min(1),
  model: z.string().optional(),
  aspect_ratio: z.string().optional(),
  quality: z.enum(["standard", "hd", "ultra"]).optional(),
});
export type CreateImageJobRequest = z.infer<typeof createImageJobRequestSchema>;

// --- API Response schemas ---

export const jobResponseSchema = z.object({
  job: backgroundJobSchema,
});
export type JobResponse = z.infer<typeof jobResponseSchema>;

export const jobListResponseSchema = z.object({
  jobs: z.array(backgroundJobSchema),
});
export type JobListResponse = z.infer<typeof jobListResponseSchema>;
