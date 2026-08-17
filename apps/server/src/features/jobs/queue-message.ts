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

export type AuthoritativeGenerationJob = {
  id: string;
  job_type: BackgroundJobType;
  workspace_id: string;
  project_id: string | null;
  canvas_id: string | null;
  session_id: string | null;
  thread_id: string | null;
  payload: Record<string, unknown>;
};

export type QueueDispatch = {
  jobId: string;
  jobType: BackgroundJobType;
  payload: GenerationQueueEnvelope["payload"];
};

export type QueueMessageRejection = {
  status: "rejected";
  jobId: string;
  code:
    | "invalid_queue_message"
    | "queue_type_mismatch"
    | "queue_integrity_mismatch";
  message: string;
};

export type QueueMessageResolution =
  | { status: "ready"; dispatch: QueueDispatch }
  | QueueMessageRejection
  | {
      status: "retryable";
      jobId: string;
      code: "job_lookup_unavailable";
      message: string;
    }
  | { status: "poison"; code: "unidentifiable_queue_message"; message: string }
  | {
      status: "poison";
      jobId: string;
      code: "orphaned_queue_job";
      message: string;
    };

type QueueSettlementActions = {
  markDeadLetter: (
    jobId: string,
    code: string,
    message: string,
  ) => Promise<void>;
  archive: () => Promise<unknown>;
};

const QUEUE_TYPES: Record<string, BackgroundJobType> = {
  image_generation_jobs: "image_generation",
  video_generation_jobs: "video_generation",
};

export function createGenerationQueueMessage(
  input: QueueMessageInput,
): GenerationQueueEnvelope {
  const context = {
    ...(input.projectId ? { project_id: input.projectId } : {}),
    ...(input.canvasId ? { canvas_id: input.canvasId } : {}),
    ...(input.sessionId ? { session_id: input.sessionId } : {}),
    ...(input.threadId ? { thread_id: input.threadId } : {}),
  };

  return generationQueueEnvelopeSchema.parse({
    job_id: input.jobId,
    job_type: input.jobType,
    workspace_id: input.workspaceId,
    ...context,
    schemaVersion: 1,
    type: input.jobType,
    payload: {
      ...input.payload,
      job_id: input.jobId,
      workspace_id: input.workspaceId,
      ...context,
    },
  });
}

export async function resolveGenerationQueueMessage(options: {
  queue: string;
  message: unknown;
  lookupJob: (jobId: string) => Promise<AuthoritativeGenerationJob>;
}): Promise<QueueMessageResolution> {
  const raw = asRecord(options.message);
  const payload = asRecord(raw?.payload);
  const jobId = stringField(raw, "job_id") ?? stringField(payload, "job_id");

  if (!jobId) {
    return {
      status: "poison",
      code: "unidentifiable_queue_message",
      message: "Queue message has no recoverable job_id.",
    };
  }

  let job: AuthoritativeGenerationJob;
  try {
    job = await options.lookupJob(jobId);
  } catch (error) {
    if (hasErrorCode(error, "job_not_found")) {
      return {
        status: "poison",
        jobId,
        code: "orphaned_queue_job",
        message: "Queue message references a job that no longer exists.",
      };
    }
    return {
      status: "retryable",
      jobId,
      code: "job_lookup_unavailable",
      message: "Authoritative job lookup is temporarily unavailable.",
    };
  }

  const declaresVersionedEnvelope =
    raw?.schemaVersion !== undefined ||
    raw?.type !== undefined ||
    raw?.payload !== undefined;
  if (
    declaresVersionedEnvelope &&
    !generationQueueEnvelopeSchema.safeParse(options.message).success
  ) {
    return {
      status: "rejected",
      jobId,
      code: "invalid_queue_message",
      message: "Versioned queue message does not match the v1 contract.",
    };
  }

  const expectedType = QUEUE_TYPES[options.queue];
  const messageTypes = [
    stringField(raw, "job_type"),
    stringField(raw, "type"),
  ].filter((value): value is string => value !== undefined);
  if (!expectedType || messageTypes.some((value) => value !== expectedType)) {
    return {
      status: "rejected",
      jobId,
      code: "queue_type_mismatch",
      message: "Queue message type does not match the physical queue.",
    };
  }

  if (
    job.id !== jobId ||
    job.job_type !== expectedType ||
    hasMismatch(raw, payload, "workspace_id", job.workspace_id) ||
    hasMismatch(raw, payload, "project_id", job.project_id) ||
    hasMismatch(raw, payload, "canvas_id", job.canvas_id) ||
    hasMismatch(raw, payload, "session_id", job.session_id) ||
    hasMismatch(raw, payload, "thread_id", job.thread_id)
  ) {
    return {
      status: "rejected",
      jobId,
      code: "queue_integrity_mismatch",
      message: "Queue message identifiers do not match the authoritative job.",
    };
  }

  try {
    const normalized = createGenerationQueueMessage({
      jobId: job.id,
      workspaceId: job.workspace_id,
      ...(job.project_id ? { projectId: job.project_id } : {}),
      ...(job.canvas_id ? { canvasId: job.canvas_id } : {}),
      ...(job.session_id ? { sessionId: job.session_id } : {}),
      ...(job.thread_id ? { threadId: job.thread_id } : {}),
      jobType: job.job_type,
      payload: job.payload,
    });

    return {
      status: "ready",
      dispatch: {
        jobId: normalized.payload.job_id,
        jobType: normalized.type,
        payload: normalized.payload,
      },
    };
  } catch {
    return {
      status: "rejected",
      jobId,
      code: "invalid_queue_message",
      message: "Authoritative job payload does not match its generation type.",
    };
  }
}

export async function settleRejectedGenerationQueueMessage(
  rejection: QueueMessageRejection,
  actions: QueueSettlementActions,
): Promise<void> {
  await actions.markDeadLetter(
    rejection.jobId,
    rejection.code,
    rejection.message,
  );
  await actions.archive();
}

export async function settleNonReadyGenerationQueueMessage(
  resolution: Exclude<QueueMessageResolution, { status: "ready" }>,
  actions: QueueSettlementActions,
): Promise<"retry" | "archived" | "dead_lettered"> {
  if (resolution.status === "retryable") {
    return "retry";
  }
  if (resolution.status === "poison") {
    await actions.archive();
    return "archived";
  }

  await settleRejectedGenerationQueueMessage(resolution, actions);
  return "dead_lettered";
}

function hasErrorCode(
  error: unknown,
  code: string,
): error is Error & { code: string } {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { code?: unknown }).code === code
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(
  value: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  return typeof value?.[key] === "string" ? value[key] : undefined;
}

function hasMismatch(
  message: Record<string, unknown> | undefined,
  payload: Record<string, unknown> | undefined,
  key: string,
  authoritative: string | null,
): boolean {
  const values = [stringField(message, key), stringField(payload, key)].filter(
    (value): value is string => value !== undefined,
  );
  return values.some((value) => value !== authoritative);
}
