import type { AgentExecutionContext } from "../../agent/execution-context.js";
import type { AdminSupabaseClient } from "../../supabase/admin.js";

export interface AgentRunAcceptance {
  readonly clientRequestId: string;
  readonly requestDigest: string;
  readonly context: Readonly<AgentExecutionContext>;
  readonly sessionId?: string;
  readonly threadId?: string;
  readonly model?: string;
}

export interface AgentAcceptanceResult {
  readonly created: boolean;
  readonly runId: string;
}

export interface AgentExecutionRepository {
  accept(input: AgentRunAcceptance): Promise<AgentAcceptanceResult>;
}

interface StoredAcceptance {
  readonly clientRequestId: string;
  readonly requestDigest: string;
  readonly context: Readonly<AgentExecutionContext>;
  readonly attempt: {
    readonly attemptId: string;
    readonly status: "accepted";
  };
  readonly outbox: readonly {
    readonly eventType: "agent.run.accepted";
    readonly publishedAt: null;
  }[];
}

export class MemoryAgentExecutionRepository
  implements AgentExecutionRepository
{
  readonly #byRun = new Map<string, StoredAcceptance>();
  readonly #byIdempotencyKey = new Map<string, StoredAcceptance>();

  get size(): number {
    return this.#byRun.size;
  }

  get(runId: string): StoredAcceptance | undefined {
    return this.#byRun.get(runId);
  }

  async accept(input: AgentRunAcceptance): Promise<AgentAcceptanceResult> {
    const key = `${input.context.userId}\0${input.clientRequestId}`;
    const existing = this.#byIdempotencyKey.get(key);
    if (existing) {
      if (existing.requestDigest !== input.requestDigest) {
        throw new Error("agent_acceptance_conflict");
      }
      return { created: false, runId: existing.context.runId };
    }

    const stored: StoredAcceptance = Object.freeze({
      clientRequestId: input.clientRequestId,
      requestDigest: input.requestDigest,
      context: input.context,
      attempt: Object.freeze({
        attemptId: input.context.attemptId,
        status: "accepted" as const,
      }),
      outbox: Object.freeze([
        Object.freeze({
          eventType: "agent.run.accepted" as const,
          publishedAt: null,
        }),
      ]),
    });
    this.#byRun.set(input.context.runId, stored);
    this.#byIdempotencyKey.set(key, stored);
    return { created: true, runId: input.context.runId };
  }
}

export function createAgentExecutionRepository(options: {
  getAdminClient: () => AdminSupabaseClient;
}): AgentExecutionRepository {
  return {
    async accept(input) {
      const client = options.getAdminClient() as unknown as {
        rpc(
          name: string,
          args: Record<string, unknown>,
        ): Promise<{ data: unknown; error: { message?: string } | null }>;
      };
      const { data, error } = await client.rpc("accept_agent_run", {
        p_attempt_id: input.context.attemptId,
        p_canvas_id: input.context.canvasId,
        p_capabilities: input.context.capabilities,
        p_capability_policy_version: input.context.capabilityPolicyVersion,
        p_client_request_id: input.clientRequestId,
        p_effective_skill_names: input.context.effectiveSkillNames,
        p_project_id: input.context.projectId,
        p_request_digest: input.requestDigest,
        p_run_id: input.context.runId,
        p_session_id: input.sessionId ?? null,
        p_skill_catalog_digest: input.context.skillCatalogDigest,
        p_thread_id: input.threadId ?? input.sessionId ?? null,
        p_user_id: input.context.userId,
        p_workspace_id: input.context.workspaceId,
        p_model: input.model ?? null,
      });
      if (error) {
        if (error.message?.includes("agent_acceptance_conflict")) {
          throw new Error("agent_acceptance_conflict");
        }
        throw new Error("agent_acceptance_persistence_failed");
      }
      const row = Array.isArray(data) ? data[0] : data;
      if (!isAcceptanceResult(row)) {
        throw new Error("agent_acceptance_persistence_failed");
      }
      return { created: row.created, runId: row.run_id };
    },
  };
}

function isAcceptanceResult(
  value: unknown,
): value is { created: boolean; run_id: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { created?: unknown }).created === "boolean" &&
    typeof (value as { run_id?: unknown }).run_id === "string"
  );
}
