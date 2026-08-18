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
  getExecutionContext(
    runId: string,
  ): Promise<Readonly<AgentExecutionContext> | null>;
  resolveSkillCursor(input: {
    runId: string;
    cursor: string;
  }): Promise<SkillCursorBinding | null>;
  reserveSkillRead(
    input: SkillReadReservation,
  ): Promise<SkillReadReservationResult>;
}

export interface SkillCursorBinding {
  readonly skillName: string;
  readonly path: string;
  readonly byteOffset: number;
}

export interface SkillReadReservation {
  readonly runId: string;
  readonly logicalReadKey: string;
  readonly byteCount: number;
  readonly proposedNextCursor?: string;
  readonly nextCursorBinding?: SkillCursorBinding;
}

export interface SkillReadReservationResult {
  readonly nextCursor?: string;
  readonly repeated: boolean;
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
  readonly #skillBudgets = new Map<
    string,
    {
      bytes: number;
      reads: Map<string, SkillReadReservationResult>;
      cursors: Map<string, SkillCursorBinding>;
    }
  >();

  get size(): number {
    return this.#byRun.size;
  }

  get(runId: string): StoredAcceptance | undefined {
    return this.#byRun.get(runId);
  }

  async getExecutionContext(
    runId: string,
  ): Promise<Readonly<AgentExecutionContext> | null> {
    return this.#byRun.get(runId)?.context ?? null;
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

  async resolveSkillCursor(input: {
    runId: string;
    cursor: string;
  }): Promise<SkillCursorBinding | null> {
    return (
      this.#skillBudgets.get(input.runId)?.cursors.get(input.cursor) ?? null
    );
  }

  async reserveSkillRead(
    input: SkillReadReservation,
  ): Promise<SkillReadReservationResult> {
    let budget = this.#skillBudgets.get(input.runId);
    if (!budget) {
      budget = { bytes: 0, reads: new Map(), cursors: new Map() };
      this.#skillBudgets.set(input.runId, budget);
    }
    const existing = budget.reads.get(input.logicalReadKey);
    if (existing) return { ...existing, repeated: true };
    if (
      budget.reads.size >= 16 ||
      budget.bytes + input.byteCount > 256 * 1024
    ) {
      throw new Error("skill_read_budget_exceeded");
    }
    const result = Object.freeze({
      ...(input.proposedNextCursor
        ? { nextCursor: input.proposedNextCursor }
        : {}),
      repeated: false,
    });
    budget.reads.set(input.logicalReadKey, result);
    budget.bytes += input.byteCount;
    if (input.proposedNextCursor && input.nextCursorBinding) {
      budget.cursors.set(input.proposedNextCursor, input.nextCursorBinding);
    }
    return result;
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
    async getExecutionContext(runId) {
      const client =
        options.getAdminClient() as unknown as AgentContextQueryClient;
      const { data, error } = await client
        .from("agent_runs")
        .select(
          "id, user_id, workspace_id, project_id, canvas_id, capabilities, capability_policy_version, skill_catalog_digest, effective_skill_names, agent_run_attempts!inner(attempt_id,status,created_at)",
        )
        .eq("id", runId)
        .in("agent_run_attempts.status", ["accepted", "running"])
        .order("created_at", {
          ascending: false,
          referencedTable: "agent_run_attempts",
        })
        .limit(1, { referencedTable: "agent_run_attempts" })
        .maybeSingle();
      if (error || !isExecutionContextRow(data)) return null;
      return {
        runId: data.id,
        attemptId: data.agent_run_attempts[0].attempt_id,
        userId: data.user_id,
        workspaceId: data.workspace_id,
        projectId: data.project_id,
        canvasId: data.canvas_id,
        capabilities:
          data.capabilities as AgentExecutionContext["capabilities"],
        capabilityPolicyVersion: data.capability_policy_version,
        skillCatalogDigest: data.skill_catalog_digest,
        effectiveSkillNames: data.effective_skill_names as string[],
      };
    },
    async resolveSkillCursor(input) {
      const client =
        options.getAdminClient() as unknown as SkillCursorQueryClient;
      const query = client
        .from("agent_skill_read_cursors")
        .select("skill_name, path, byte_offset")
        .eq("run_id", input.runId)
        .eq("cursor", input.cursor);
      const { data, error } = await query.maybeSingle();
      if (error || !data) return null;
      return {
        skillName: data.skill_name,
        path: data.path,
        byteOffset: data.byte_offset,
      };
    },
    async reserveSkillRead(input) {
      const client = options.getAdminClient() as unknown as {
        rpc(
          name: string,
          args: Record<string, unknown>,
        ): Promise<{ data: unknown; error: { message?: string } | null }>;
      };
      const { data, error } = await client.rpc("reserve_agent_skill_read", {
        p_byte_count: input.byteCount,
        p_logical_read_key: input.logicalReadKey,
        p_next_byte_offset: input.nextCursorBinding?.byteOffset ?? null,
        p_next_cursor: input.proposedNextCursor ?? null,
        p_path: input.nextCursorBinding?.path ?? null,
        p_run_id: input.runId,
        p_skill_name: input.nextCursorBinding?.skillName ?? null,
      });
      if (error) {
        if (error.message?.includes("skill_read_budget_exceeded")) {
          throw new Error("skill_read_budget_exceeded");
        }
        throw new Error("skill_read_persistence_failed");
      }
      const row = Array.isArray(data) ? data[0] : data;
      if (!isSkillReservationResult(row)) {
        throw new Error("skill_read_persistence_failed");
      }
      return {
        ...(row.next_cursor ? { nextCursor: row.next_cursor } : {}),
        repeated: row.repeated,
      };
    },
  };
}

interface SkillCursorQueryClient {
  from(name: string): {
    select(columns: string): {
      eq(
        column: string,
        value: string,
      ): {
        eq(
          column: string,
          value: string,
        ): {
          maybeSingle(): Promise<{
            data: {
              skill_name: string;
              path: string;
              byte_offset: number;
            } | null;
            error: unknown;
          }>;
        };
      };
    };
  };
}

interface AgentContextQueryClient {
  from(name: string): {
    select(columns: string): {
      eq(
        column: string,
        value: string,
      ): {
        in(
          column: string,
          values: string[],
        ): {
          order(
            column: string,
            options: { ascending: boolean; referencedTable: string },
          ): {
            limit(
              count: number,
              options: { referencedTable: string },
            ): {
              maybeSingle(): Promise<{ data: unknown; error: unknown }>;
            };
          };
        };
      };
    };
  };
}

function isExecutionContextRow(value: unknown): value is {
  id: string;
  user_id: string;
  workspace_id: string;
  project_id: string;
  canvas_id: string;
  capabilities: unknown;
  capability_policy_version: string;
  skill_catalog_digest: string;
  effective_skill_names: unknown;
  agent_run_attempts: [{ attempt_id: string }];
} {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    [
      "id",
      "user_id",
      "workspace_id",
      "project_id",
      "canvas_id",
      "capability_policy_version",
      "skill_catalog_digest",
    ].every((key) => typeof row[key] === "string") &&
    Array.isArray(row.capabilities) &&
    Array.isArray(row.effective_skill_names) &&
    Array.isArray(row.agent_run_attempts) &&
    typeof row.agent_run_attempts[0]?.attempt_id === "string"
  );
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

function isSkillReservationResult(
  value: unknown,
): value is { next_cursor: string | null; repeated: boolean } {
  return (
    typeof value === "object" &&
    value !== null &&
    ((value as { next_cursor?: unknown }).next_cursor === null ||
      typeof (value as { next_cursor?: unknown }).next_cursor === "string") &&
    typeof (value as { repeated?: unknown }).repeated === "boolean"
  );
}
