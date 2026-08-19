import type { AdminSupabaseClient } from "../../supabase/admin.js";
import type {
  CreateAcceptedAgentRunInput,
  UpdateAgentRunInput,
} from "./types.js";

export class AgentRunPersistenceError extends Error {
  readonly statusCode: number;
  readonly code: "application_error";

  constructor(message: string, statusCode = 500) {
    super(message);
    this.code = "application_error";
    this.statusCode = statusCode;
  }
}

export type AgentRunMetadataService = {
  createAcceptedRun(input: CreateAcceptedAgentRunInput): Promise<void>;
  updateRun(input: UpdateAgentRunInput): Promise<void>;
};

export function createAgentRunMetadataService(options: {
  getAdminClient: () => AdminSupabaseClient;
  retryDelayMs?: number;
}): AgentRunMetadataService {
  const retryDelayMs = options.retryDelayMs ?? 100;
  return {
    async createAcceptedRun(input) {
      const { error } = await options
        .getAdminClient()
        .from("agent_runs")
        .insert({
          id: input.runId,
          model: input.model ?? null,
          session_id: input.sessionId,
          status: "accepted",
          thread_id: input.threadId,
        });

      if (error) {
        throw new AgentRunPersistenceError("Failed to persist accepted run.");
      }
    },

    async updateRun(input) {
      const patch = {
        ...(input.completedAt ? { completed_at: input.completedAt } : {}),
        ...(input.errorCode ? { error_code: input.errorCode } : {}),
        ...(input.errorMessage ? { error_message: input.errorMessage } : {}),
        status: input.status,
      };
      // Status patches are idempotent, so a bounded retry prevents a transient
      // PostgREST failure from converting a successful Agent run into failure.
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const { error } = await options
          .getAdminClient()
          .from("agent_runs")
          .update(patch)
          .eq("id", input.runId);

        if (!error) return;
        if (attempt < 3 && retryDelayMs > 0) {
          await new Promise((resolve) =>
            setTimeout(resolve, retryDelayMs * attempt),
          );
        }
      }
      throw new AgentRunPersistenceError("Failed to update run metadata.");
    },
  };
}
