import { z } from "zod";
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

export interface PersistedAgentAcceptance {
  readonly model?: string;
  readonly requestDigest: string;
  readonly runId: string;
}

export type AgentAcceptanceRepositoryFailureKind =
  | "conflict"
  | "definitive_failed"
  | "definitive_unavailable"
  | "indeterminate"
  | "lookup_unavailable";

export class AgentAcceptanceRepositoryError extends Error {
  readonly kind: AgentAcceptanceRepositoryFailureKind;

  constructor(kind: AgentAcceptanceRepositoryFailureKind) {
    super(repositoryFailureCode(kind));
    this.name = "AgentAcceptanceRepositoryError";
    this.kind = kind;
  }
}

export interface AgentExecutionRepository {
  accept(
    input: AgentRunAcceptance,
    signal?: AbortSignal,
  ): Promise<AgentAcceptanceResult>;
  findAcceptance(input: {
    readonly clientRequestId: string;
    readonly signal?: AbortSignal;
    readonly userId: string;
  }): Promise<PersistedAgentAcceptance | null>;
  claimAttempt(input: AttemptClaim): Promise<AttemptLease>;
  renewAttempt(input: AttemptRenewal): Promise<AttemptRenewalResult>;
  recoverExpiredRuns(
    input: ExpiredRunRecoveryRequest,
  ): Promise<readonly ExpiredRunRecoveryResult[]>;
  finalizeRun(input: FinalizeAgentRun): Promise<FinalizedAgentRun>;
  beginEffect(input: AgentEffectRequest): Promise<AgentEffectReservation>;
  completeEffect(
    input: AgentEffectRequest & { result: unknown },
  ): Promise<void>;
  cancelAttempt(input: AttemptFence): Promise<void>;
  isAttemptActive(input: AttemptFence): Promise<boolean>;
  resumeAttempt(input: ResumeAttempt): Promise<Readonly<AgentExecutionContext>>;
  getAttemptState(runId: string): Promise<AttemptState | null>;
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

export type AgentTerminalStatus = "completed" | "failed" | "canceled";

export interface FinalizeAgentRun {
  readonly runId: string;
  readonly attemptId: string;
  readonly fencingToken: number;
  readonly status: AgentTerminalStatus;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface FinalizedAgentRun {
  readonly status: AgentTerminalStatus;
  readonly completedAt: Date;
}

export interface AttemptClaim {
  readonly attemptId: string;
  readonly leaseOwner: string;
  readonly leaseMs: number;
  readonly now: Date;
}

export interface AttemptLease {
  readonly attemptId: string;
  readonly fencingToken: number;
  readonly leaseExpiresAt: Date;
}

export interface AttemptRenewal extends AttemptFence {
  readonly leaseOwner: string;
  readonly leaseMs: number;
  readonly now: Date;
}

export interface AttemptRenewalResult {
  readonly leaseExpiresAt: Date;
}

export interface ExpiredRunRecoveryRequest {
  readonly graceMs: number;
  readonly limit: number;
  readonly now: Date;
}

export interface ExpiredRunRecoveryResult {
  readonly runId: string;
  readonly attemptId: string;
  readonly status: "failed";
}

export interface AttemptState {
  readonly attemptId: string;
  readonly status: "accepted" | "running";
  readonly leaseExpiresAt?: Date;
}

export interface AttemptFence {
  readonly attemptId: string;
  readonly fencingToken: number;
}

export interface AgentEffectRequest extends AttemptFence {
  readonly runId: string;
  readonly logicalToolCallId: string;
  readonly inputDigest: string;
}

export type AgentEffectReservation =
  | { readonly status: "reserved" }
  | { readonly status: "completed"; readonly result: unknown };

export interface ResumeAttempt {
  readonly runId: string;
  readonly attemptId: string;
  readonly activeCatalogDigest: string;
  readonly currentCapabilities: readonly AgentExecutionContext["capabilities"][number][];
  readonly capabilityPolicyVersion: string;
  readonly effectiveSkillNames: readonly string[];
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
  readonly model?: string;
  readonly requestDigest: string;
  context: Readonly<AgentExecutionContext>;
  runStatus: "accepted" | "running" | AgentTerminalStatus;
  completedAt?: Date;
  attempt: {
    readonly attemptId: string;
    status: "accepted" | "running" | "cancelled" | AgentTerminalStatus;
    leaseOwner?: string;
    leaseExpiresAt?: Date;
    completedAt?: Date;
    fencingToken: number;
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
  readonly #effects = new Map<
    string,
    { inputDigest: string; completed: boolean; result?: unknown }
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
    const stored = this.#byRun.get(runId);
    return stored &&
      (stored.attempt.status === "accepted" ||
        stored.attempt.status === "running")
      ? stored.context
      : null;
  }

  async getAttemptState(runId: string): Promise<AttemptState | null> {
    const stored = this.#byRun.get(runId);
    if (
      !stored ||
      (stored.attempt.status !== "accepted" &&
        stored.attempt.status !== "running")
    ) {
      return null;
    }
    return {
      attemptId: stored.attempt.attemptId,
      status: stored.attempt.status,
      ...(stored.attempt.leaseExpiresAt
        ? { leaseExpiresAt: new Date(stored.attempt.leaseExpiresAt) }
        : {}),
    };
  }

  async accept(
    input: AgentRunAcceptance,
    signal?: AbortSignal,
  ): Promise<AgentAcceptanceResult> {
    signal?.throwIfAborted();
    const key = `${input.context.userId}\0${input.clientRequestId}`;
    const existing = this.#byIdempotencyKey.get(key);
    if (existing) {
      if (existing.requestDigest !== input.requestDigest) {
        throw new AgentAcceptanceRepositoryError("conflict");
      }
      return { created: false, runId: existing.context.runId };
    }

    const stored: StoredAcceptance = {
      clientRequestId: input.clientRequestId,
      ...(input.model ? { model: input.model } : {}),
      requestDigest: input.requestDigest,
      context: input.context,
      runStatus: "accepted",
      attempt: {
        attemptId: input.context.attemptId,
        status: "accepted" as const,
        fencingToken: 0,
      },
      outbox: Object.freeze([
        Object.freeze({
          eventType: "agent.run.accepted" as const,
          publishedAt: null,
        }),
      ]),
    };
    this.#byRun.set(input.context.runId, stored);
    this.#byIdempotencyKey.set(key, stored);
    return { created: true, runId: input.context.runId };
  }

  async findAcceptance(input: {
    readonly clientRequestId: string;
    readonly signal?: AbortSignal;
    readonly userId: string;
  }): Promise<PersistedAgentAcceptance | null> {
    input.signal?.throwIfAborted();
    const stored = this.#byIdempotencyKey.get(
      `${input.userId}\0${input.clientRequestId}`,
    );
    if (!stored) return null;
    return {
      ...(stored.model ? { model: stored.model } : {}),
      requestDigest: stored.requestDigest,
      runId: stored.context.runId,
    };
  }

  async claimAttempt(input: AttemptClaim): Promise<AttemptLease> {
    const stored = this.#findByAttempt(input.attemptId);
    if (!stored || stored.attempt.status === "cancelled") {
      throw new Error("run_not_active");
    }
    const attempt = stored.attempt;
    if (
      attempt.status === "running" &&
      attempt.leaseExpiresAt &&
      attempt.leaseExpiresAt.getTime() > input.now.getTime() &&
      attempt.leaseOwner !== input.leaseOwner
    ) {
      throw new Error("attempt_lease_unavailable");
    }
    const fencingToken = attempt.fencingToken + 1;
    const leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs);
    stored.attempt = {
      attemptId: input.attemptId,
      status: "running",
      leaseOwner: input.leaseOwner,
      leaseExpiresAt,
      fencingToken,
    };
    stored.runStatus = "running";
    return { attemptId: input.attemptId, fencingToken, leaseExpiresAt };
  }

  async renewAttempt(input: AttemptRenewal): Promise<AttemptRenewalResult> {
    const stored = this.#findByAttempt(input.attemptId);
    const attempt = stored?.attempt;
    if (
      !stored ||
      !attempt ||
      attempt.status !== "running" ||
      attempt.fencingToken !== input.fencingToken ||
      attempt.leaseOwner !== input.leaseOwner ||
      !attempt.leaseExpiresAt ||
      attempt.leaseExpiresAt.getTime() <= input.now.getTime()
    ) {
      throw new Error("run_not_active");
    }
    const leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs);
    attempt.leaseExpiresAt = leaseExpiresAt;
    return { leaseExpiresAt };
  }

  async recoverExpiredRuns(
    _input: ExpiredRunRecoveryRequest,
  ): Promise<readonly ExpiredRunRecoveryResult[]> {
    // Process-local repositories have no crashed process to recover. Durable
    // recovery is implemented by the Supabase repository below.
    return [];
  }

  async finalizeRun(input: FinalizeAgentRun): Promise<FinalizedAgentRun> {
    const stored = this.#byRun.get(input.runId);
    if (!stored || stored.attempt.attemptId !== input.attemptId) {
      throw new Error("agent_attempt_not_current");
    }
    if (stored.completedAt && isAgentTerminalStatus(stored.runStatus)) {
      return {
        status: stored.runStatus,
        completedAt: new Date(stored.completedAt),
      };
    }
    if (
      stored.attempt.status !== "running" ||
      stored.attempt.fencingToken !== input.fencingToken
    ) {
      throw new Error("run_not_active");
    }

    const completedAt = new Date();
    stored.runStatus = input.status;
    stored.completedAt = completedAt;
    stored.attempt = {
      attemptId: input.attemptId,
      status: input.status,
      fencingToken: input.fencingToken,
      completedAt,
    };
    return { status: input.status, completedAt: new Date(completedAt) };
  }

  async beginEffect(
    input: AgentEffectRequest,
  ): Promise<AgentEffectReservation> {
    this.#assertActiveFence(input);
    const key = `${input.runId}\0${input.logicalToolCallId}`;
    const existing = this.#effects.get(key);
    if (existing) {
      if (existing.inputDigest !== input.inputDigest) {
        throw new Error("agent_effect_conflict");
      }
      return existing.completed
        ? { status: "completed", result: existing.result }
        : { status: "reserved" };
    }
    this.#effects.set(key, {
      inputDigest: input.inputDigest,
      completed: false,
    });
    return { status: "reserved" };
  }

  async completeEffect(
    input: AgentEffectRequest & { result: unknown },
  ): Promise<void> {
    this.#assertActiveFence(input);
    const key = `${input.runId}\0${input.logicalToolCallId}`;
    const existing = this.#effects.get(key);
    if (!existing || existing.inputDigest !== input.inputDigest) {
      throw new Error("agent_effect_conflict");
    }
    this.#effects.set(key, {
      inputDigest: input.inputDigest,
      completed: true,
      result: input.result,
    });
  }

  async cancelAttempt(input: AttemptFence): Promise<void> {
    const stored = this.#findByAttempt(input.attemptId);
    if (
      !stored ||
      stored.attempt.status !== "running" ||
      stored.attempt.fencingToken !== input.fencingToken
    ) {
      throw new Error("run_not_active");
    }
    stored.attempt = {
      attemptId: input.attemptId,
      status: "cancelled",
      fencingToken: input.fencingToken + 1,
    };
  }

  async isAttemptActive(input: AttemptFence): Promise<boolean> {
    const stored = this.#findByAttempt(input.attemptId);
    return Boolean(
      stored &&
        stored.attempt.status === "running" &&
        stored.attempt.fencingToken === input.fencingToken,
    );
  }

  async resumeAttempt(
    input: ResumeAttempt,
  ): Promise<Readonly<AgentExecutionContext>> {
    const stored = this.#byRun.get(input.runId);
    if (!stored) throw new Error("run_not_found");
    if (stored.context.skillCatalogDigest !== input.activeCatalogDigest) {
      throw new Error("skill_catalog_changed");
    }
    const allowed = new Set(input.currentCapabilities);
    const previouslyEffectiveSkills = new Set(
      stored.context.effectiveSkillNames,
    );
    const context = Object.freeze({
      ...stored.context,
      attemptId: input.attemptId,
      capabilities: Object.freeze(
        stored.context.capabilities.filter((capability) =>
          allowed.has(capability),
        ),
      ),
      capabilityPolicyVersion: input.capabilityPolicyVersion,
      effectiveSkillNames: Object.freeze(
        input.effectiveSkillNames.filter((skillName) =>
          previouslyEffectiveSkills.has(skillName),
        ),
      ),
    });
    stored.context = context;
    stored.attempt = {
      attemptId: input.attemptId,
      status: "accepted",
      fencingToken: 0,
    };
    return context;
  }

  #findByAttempt(attemptId: string): StoredAcceptance | undefined {
    return [...this.#byRun.values()].find(
      (stored) => stored.attempt.attemptId === attemptId,
    );
  }

  #assertActiveFence(input: AttemptFence & { runId?: string }): void {
    const stored = this.#findByAttempt(input.attemptId);
    if (
      !stored ||
      (input.runId !== undefined && stored.context.runId !== input.runId) ||
      stored.attempt.status !== "running" ||
      stored.attempt.fencingToken !== input.fencingToken
    ) {
      throw new Error("run_not_active");
    }
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
    async accept(input, signal) {
      const client = options.getAdminClient() as unknown as AcceptanceClient;
      let query = client.rpc("accept_agent_run", {
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
      if (signal) query = query.abortSignal(signal);

      let result: AcceptanceRpcResult;
      try {
        result = await query;
      } catch {
        throw new AgentAcceptanceRepositoryError("indeterminate");
      }
      const { data, error } = result;
      if (error) {
        throw classifyAcceptanceError(error);
      }
      const row = Array.isArray(data) ? data[0] : data;
      if (!isAcceptanceResult(row)) {
        throw new AgentAcceptanceRepositoryError("indeterminate");
      }
      return { created: row.created, runId: row.run_id };
    },
    async findAcceptance(input) {
      const client = options.getAdminClient() as unknown as AcceptanceClient;
      let query = client
        .from("agent_runs")
        .select("id, request_digest, model")
        .eq("user_id", input.userId)
        .eq("client_request_id", input.clientRequestId);
      if (input.signal) query = query.abortSignal(input.signal);

      let result: AcceptanceLookupResult;
      try {
        result = await query.maybeSingle();
      } catch {
        throw new AgentAcceptanceRepositoryError("lookup_unavailable");
      }
      if (result.error) {
        throw new AgentAcceptanceRepositoryError("lookup_unavailable");
      }
      if (result.data === null) return null;
      if (!isPersistedAcceptanceRow(result.data)) {
        throw new AgentAcceptanceRepositoryError("lookup_unavailable");
      }
      return {
        ...(result.data.model ? { model: result.data.model } : {}),
        requestDigest: result.data.request_digest,
        runId: result.data.id,
      };
    },
    async claimAttempt(input) {
      const row = await callAgentExecutionRpc(options, "claim_agent_attempt", {
        p_attempt_id: input.attemptId,
        p_lease_ms: input.leaseMs,
        p_lease_owner: input.leaseOwner,
        p_now: input.now.toISOString(),
      });
      if (!isAttemptLeaseRow(row)) {
        throw new Error("agent_execution_persistence_failed");
      }
      return {
        attemptId: row.attempt_id,
        fencingToken: row.fencing_token,
        leaseExpiresAt: new Date(row.lease_expires_at),
      };
    },
    async renewAttempt(input) {
      const row = await callAgentExecutionRpc(
        options,
        "renew_agent_run_attempt",
        {
          p_attempt_id: input.attemptId,
          p_fencing_token: input.fencingToken,
          p_lease_owner: input.leaseOwner,
          p_lease_ms: input.leaseMs,
        },
      );
      if (!isAttemptRenewalRow(row)) {
        throw new Error("agent_execution_persistence_failed");
      }
      return { leaseExpiresAt: new Date(row.lease_expires_at) };
    },
    async recoverExpiredRuns(input) {
      const client = options.getAdminClient() as unknown as {
        rpc(
          name: string,
          args: Record<string, unknown>,
        ): Promise<{ data: unknown; error: unknown }>;
      };
      const { data, error } = await client.rpc("recover_expired_agent_runs", {
        p_grace_ms: input.graceMs,
        p_limit: input.limit,
        p_now: input.now.toISOString(),
      });
      if (error) throw new Error("agent_execution_persistence_failed");
      const parsed = expiredRunRecoveryRowsSchema.safeParse(data ?? []);
      if (!parsed.success) {
        throw new Error("agent_execution_persistence_failed");
      }
      return parsed.data;
    },
    async finalizeRun(input) {
      const row = await callAgentExecutionRpc(options, "finalize_agent_run", {
        p_attempt_id: input.attemptId,
        p_fencing_token: input.fencingToken,
        p_metadata: input.metadata,
        p_run_id: input.runId,
        p_status: input.status,
      });
      if (!isFinalizedAgentRunRow(row)) {
        throw new Error("agent_execution_persistence_failed");
      }
      return {
        status: row.status,
        completedAt: new Date(row.completedAt),
      };
    },
    async beginEffect(input) {
      const row = await callAgentExecutionRpc(options, "begin_agent_effect", {
        p_attempt_id: input.attemptId,
        p_fencing_token: input.fencingToken,
        p_input_digest: input.inputDigest,
        p_logical_tool_call_id: input.logicalToolCallId,
        p_run_id: input.runId,
      });
      if (!isEffectReservationRow(row)) {
        throw new Error("agent_execution_persistence_failed");
      }
      return row.status === "completed"
        ? { status: "completed", result: row.result }
        : { status: "reserved" };
    },
    async completeEffect(input) {
      await callAgentExecutionRpc(options, "complete_agent_effect", {
        p_attempt_id: input.attemptId,
        p_fencing_token: input.fencingToken,
        p_input_digest: input.inputDigest,
        p_logical_tool_call_id: input.logicalToolCallId,
        p_result: input.result,
        p_run_id: input.runId,
      });
    },
    async cancelAttempt(input) {
      await callAgentExecutionRpc(options, "cancel_agent_attempt", {
        p_attempt_id: input.attemptId,
        p_fencing_token: input.fencingToken,
      });
    },
    async isAttemptActive(input) {
      const row = await callAgentExecutionRpc(
        options,
        "is_agent_attempt_active",
        {
          p_attempt_id: input.attemptId,
          p_fencing_token: input.fencingToken,
        },
      );
      return row === true;
    },
    async resumeAttempt(input) {
      const row = await callAgentExecutionRpc(options, "resume_agent_attempt", {
        p_active_catalog_digest: input.activeCatalogDigest,
        p_attempt_id: input.attemptId,
        p_capability_policy_version: input.capabilityPolicyVersion,
        p_current_capabilities: input.currentCapabilities,
        p_effective_skill_names: input.effectiveSkillNames,
        p_run_id: input.runId,
      });
      if (!isResumeContextRow(row)) {
        throw new Error("agent_execution_persistence_failed");
      }
      return {
        runId: row.id,
        attemptId: row.attempt_id,
        userId: row.user_id,
        workspaceId: row.workspace_id,
        projectId: row.project_id,
        canvasId: row.canvas_id,
        capabilities: row.capabilities as AgentExecutionContext["capabilities"],
        capabilityPolicyVersion: row.capability_policy_version,
        skillCatalogDigest: row.skill_catalog_digest,
        effectiveSkillNames: row.effective_skill_names as string[],
      };
    },
    async getExecutionContext(runId) {
      const client =
        options.getAdminClient() as unknown as AgentContextQueryClient;
      const { data, error } = await client
        .from("agent_runs")
        .select(
          "id, user_id, workspace_id, project_id, canvas_id, capabilities, capability_policy_version, skill_catalog_digest, effective_skill_names, agent_run_attempts!agent_run_attempts_run_id_fkey!inner(attempt_id,status,created_at)",
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
      return executionContextFromRow(data);
    },
    async getAttemptState(runId) {
      const client =
        options.getAdminClient() as unknown as AgentContextQueryClient;
      const { data, error } = await client
        .from("agent_runs")
        .select(
          "id, agent_run_attempts!agent_run_attempts_run_id_fkey!inner(attempt_id,status,lease_expires_at,created_at)",
        )
        .eq("id", runId)
        .in("agent_run_attempts.status", ["accepted", "running"])
        .order("created_at", {
          ascending: false,
          referencedTable: "agent_run_attempts",
        })
        .limit(1, { referencedTable: "agent_run_attempts" })
        .maybeSingle();
      if (error || !data || typeof data !== "object") return null;
      const attempts = (data as Record<string, unknown>).agent_run_attempts;
      const row = Array.isArray(attempts) ? attempts[0] : undefined;
      if (
        !row ||
        typeof row !== "object" ||
        typeof row.attempt_id !== "string" ||
        (row.status !== "accepted" && row.status !== "running")
      ) {
        return null;
      }
      return {
        attemptId: row.attempt_id,
        status: row.status,
        ...(typeof row.lease_expires_at === "string"
          ? { leaseExpiresAt: new Date(row.lease_expires_at) }
          : {}),
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

const expiredRunRecoveryRowsSchema = z.array(
  z
    .object({
      runId: z.string().uuid(),
      attemptId: z.string().uuid(),
      status: z.literal("failed"),
    })
    .strict(),
);

type AcceptanceRpcResult = {
  data: unknown;
  error: unknown;
};

type AcceptanceLookupResult = {
  data: unknown;
  error: unknown;
};

interface AbortableAcceptanceRpc extends PromiseLike<AcceptanceRpcResult> {
  abortSignal(signal: AbortSignal): AbortableAcceptanceRpc;
}

interface AcceptanceLookupQuery {
  abortSignal(signal: AbortSignal): AcceptanceLookupQuery;
  eq(column: string, value: string): AcceptanceLookupQuery;
  maybeSingle(): PromiseLike<AcceptanceLookupResult>;
  select(columns: string): AcceptanceLookupQuery;
}

interface AcceptanceClient {
  from(name: string): AcceptanceLookupQuery;
  rpc(name: string, args: Record<string, unknown>): AbortableAcceptanceRpc;
}

const DEFINITIVE_RETRYABLE_DATABASE_CODES = new Set([
  "40001",
  "40P01",
  "55P03",
  "57014",
]);

function classifyAcceptanceError(
  error: unknown,
): AgentAcceptanceRepositoryError {
  const message = safeStringField(error, "message");
  if (message?.includes("agent_acceptance_conflict")) {
    return new AgentAcceptanceRepositoryError("conflict");
  }
  const code = safeStringField(error, "code");
  if (code && DEFINITIVE_RETRYABLE_DATABASE_CODES.has(code)) {
    return new AgentAcceptanceRepositoryError("definitive_unavailable");
  }
  return new AgentAcceptanceRepositoryError("definitive_failed");
}

function repositoryFailureCode(
  kind: AgentAcceptanceRepositoryFailureKind,
): string {
  switch (kind) {
    case "conflict":
      return "agent_acceptance_conflict";
    case "definitive_unavailable":
      return "agent_acceptance_unavailable";
    case "definitive_failed":
      return "agent_acceptance_failed";
    case "indeterminate":
      return "agent_acceptance_indeterminate";
    case "lookup_unavailable":
      return "agent_acceptance_lookup_failed";
  }
}

function safeStringField(value: unknown, key: string): string | undefined {
  try {
    if (typeof value !== "object" || value === null) return undefined;
    const field = (value as Record<string, unknown>)[key];
    return typeof field === "string" ? field : undefined;
  } catch {
    return undefined;
  }
}

function isPersistedAcceptanceRow(value: unknown): value is {
  id: string;
  model: string | null;
  request_digest: string;
} {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    typeof row.request_digest === "string" &&
    (row.model === null || typeof row.model === "string")
  );
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

async function callAgentExecutionRpc(
  options: { getAdminClient: () => AdminSupabaseClient },
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const client = options.getAdminClient() as unknown as {
    rpc(
      rpcName: string,
      rpcArgs: Record<string, unknown>,
    ): Promise<{ data: unknown; error: { message?: string } | null }>;
  };
  const { data, error } = await client.rpc(name, args);
  if (error) {
    const knownErrors = [
      "attempt_lease_unavailable",
      "run_not_active",
      "agent_attempt_not_current",
      "agent_effect_conflict",
      "skill_catalog_changed",
      "run_not_found",
    ];
    const known = knownErrors.find((code) => error.message?.includes(code));
    throw new Error(known ?? "agent_execution_persistence_failed");
  }
  return Array.isArray(data) ? data[0] : data;
}

function executionContextFromRow(
  data: Parameters<typeof isExecutionContextRow>[0] & {
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
  },
): Readonly<AgentExecutionContext> {
  return {
    runId: data.id,
    attemptId: data.agent_run_attempts[0].attempt_id,
    userId: data.user_id,
    workspaceId: data.workspace_id,
    projectId: data.project_id,
    canvasId: data.canvas_id,
    capabilities: data.capabilities as AgentExecutionContext["capabilities"],
    capabilityPolicyVersion: data.capability_policy_version,
    skillCatalogDigest: data.skill_catalog_digest,
    effectiveSkillNames: data.effective_skill_names as string[],
  };
}

function isAttemptLeaseRow(value: unknown): value is {
  attempt_id: string;
  fencing_token: number;
  lease_expires_at: string;
} {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.attempt_id === "string" &&
    typeof row.fencing_token === "number" &&
    typeof row.lease_expires_at === "string"
  );
}

function isAttemptRenewalRow(value: unknown): value is {
  lease_expires_at: string;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).lease_expires_at === "string"
  );
}

function isResumeContextRow(value: unknown): value is {
  id: string;
  attempt_id: string;
  user_id: string;
  workspace_id: string;
  project_id: string;
  canvas_id: string;
  capabilities: unknown[];
  capability_policy_version: string;
  skill_catalog_digest: string;
  effective_skill_names: unknown[];
} {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    [
      "id",
      "attempt_id",
      "user_id",
      "workspace_id",
      "project_id",
      "canvas_id",
      "capability_policy_version",
      "skill_catalog_digest",
    ].every((key) => typeof row[key] === "string") &&
    Array.isArray(row.capabilities) &&
    Array.isArray(row.effective_skill_names)
  );
}

function isEffectReservationRow(value: unknown): value is {
  status: "reserved" | "completed";
  result?: unknown;
} {
  if (typeof value !== "object" || value === null) return false;
  const status = (value as { status?: unknown }).status;
  return status === "reserved" || status === "completed";
}

function isAgentTerminalStatus(value: unknown): value is AgentTerminalStatus {
  return value === "completed" || value === "failed" || value === "canceled";
}

function isFinalizedAgentRunRow(value: unknown): value is {
  status: AgentTerminalStatus;
  completedAt: string;
} {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    isAgentTerminalStatus(row.status) &&
    typeof row.completedAt === "string" &&
    !Number.isNaN(Date.parse(row.completedAt))
  );
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
