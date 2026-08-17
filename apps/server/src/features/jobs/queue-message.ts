import {
  type BackgroundJobType,
  type GenerationQueueEnvelope,
  generationQueueEnvelopeSchema,
} from "@loomic/shared";

type QueueMessageInput = {
  jobId: string;
  workspaceId: string;
  projectId?: string;
  canvasId?: string;
  sessionId?: string;
  threadId?: string;
  jobType: BackgroundJobType;
  payload: Record<string, unknown>;
};

export type QueueDispatch = {
  jobId: string;
  jobType: BackgroundJobType;
  payload: GenerationQueueEnvelope["payload"];
};

export type QueueMessageParseResult =
  | { success: true; data: QueueDispatch }
  | { success: false; code: "invalid_queue_message"; issues: unknown[] };

export function createGenerationQueueMessage(
  input: QueueMessageInput,
): GenerationQueueEnvelope {
  return generationQueueEnvelopeSchema.parse({
    schemaVersion: 1,
    type: input.jobType,
    payload: {
      ...input.payload,
      job_id: input.jobId,
      workspace_id: input.workspaceId,
      ...(input.projectId ? { project_id: input.projectId } : {}),
      ...(input.canvasId ? { canvas_id: input.canvasId } : {}),
      ...(input.sessionId ? { session_id: input.sessionId } : {}),
      ...(input.threadId ? { thread_id: input.threadId } : {}),
    },
  });
}

export function parseGenerationQueueMessage(
  message: unknown,
): QueueMessageParseResult {
  const parsed = generationQueueEnvelopeSchema.safeParse(message);
  if (!parsed.success) {
    return {
      success: false,
      code: "invalid_queue_message",
      issues: parsed.error.issues,
    };
  }

  return {
    success: true,
    data: {
      jobId: parsed.data.payload.job_id,
      jobType: parsed.data.type,
      payload: parsed.data.payload,
    },
  };
}
