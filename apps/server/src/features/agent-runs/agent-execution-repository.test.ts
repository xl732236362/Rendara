import { describe, expect, it, vi } from "vitest";

import {
  MemoryAgentExecutionRepository,
  createAgentExecutionRepository,
} from "./agent-execution-repository.js";

const acceptance = {
  clientRequestId: "request-1",
  requestDigest: "digest-1",
  model: "openai:test-model",
  context: {
    runId: "run-1",
    attemptId: "attempt-1",
    userId: "user-1",
    workspaceId: "workspace-1",
    projectId: "project-1",
    canvasId: "canvas-1",
    capabilities: ["image.generate"] as const,
    capabilityPolicyVersion: "policy-1",
    skillCatalogDigest: "catalog-1",
    effectiveSkillNames: ["json-image-prompt"],
  },
};

describe("AgentExecutionRepository", () => {
  it("atomically stores the accepted run, initial attempt and outbox", async () => {
    const repository = new MemoryAgentExecutionRepository();

    const result = await repository.accept(acceptance);

    expect(result.created).toBe(true);
    expect(repository.get("run-1")).toMatchObject({
      attempt: { attemptId: "attempt-1", status: "accepted" },
      outbox: [{ eventType: "agent.run.accepted", publishedAt: null }],
    });
  });

  it("deduplicates identical input and rejects conflicting input", async () => {
    const repository = new MemoryAgentExecutionRepository();
    await repository.accept(acceptance);

    await expect(repository.accept(acceptance)).resolves.toMatchObject({
      created: false,
      runId: "run-1",
    });
    await expect(
      repository.accept({ ...acceptance, requestDigest: "digest-other" }),
    ).rejects.toThrow("agent_acceptance_conflict");
  });

  it("finds a durable acceptance by user and client request", async () => {
    const repository = new MemoryAgentExecutionRepository();
    await repository.accept(acceptance);

    await expect(
      repository.findAcceptance({
        clientRequestId: "request-1",
        userId: "user-1",
      }),
    ).resolves.toEqual({
      model: "openai:test-model",
      requestDigest: "digest-1",
      runId: "run-1",
    });
  });

  it("leases an attempt to one owner and fences an expired owner", async () => {
    const repository = new MemoryAgentExecutionRepository();
    await repository.accept(acceptance);
    const first = await repository.claimAttempt({
      attemptId: "attempt-1",
      leaseOwner: "worker-1",
      leaseMs: 1_000,
      now: new Date("2026-08-19T00:00:00.000Z"),
    });
    expect(first.fencingToken).toBe(1);
    await expect(
      repository.claimAttempt({
        attemptId: "attempt-1",
        leaseOwner: "worker-2",
        leaseMs: 1_000,
        now: new Date("2026-08-19T00:00:00.500Z"),
      }),
    ).rejects.toThrow("attempt_lease_unavailable");
    const takeover = await repository.claimAttempt({
      attemptId: "attempt-1",
      leaseOwner: "worker-2",
      leaseMs: 1_000,
      now: new Date("2026-08-19T00:00:02.000Z"),
    });
    expect(takeover.fencingToken).toBe(2);
    await expect(
      repository.isAttemptActive({
        attemptId: "attempt-1",
        fencingToken: first.fencingToken,
      }),
    ).resolves.toBe(false);
    await expect(
      repository.isAttemptActive({
        attemptId: "attempt-1",
        fencingToken: takeover.fencingToken,
      }),
    ).resolves.toBe(true);
  });

  it("renews only the current owner and fencing token", async () => {
    const repository = new MemoryAgentExecutionRepository();
    await repository.accept(acceptance);
    const lease = await repository.claimAttempt({
      attemptId: "attempt-1",
      leaseOwner: "worker-1",
      leaseMs: 60_000,
      now: new Date("2026-08-19T00:00:00.000Z"),
    });

    await expect(
      repository.renewAttempt({
        attemptId: "attempt-1",
        fencingToken: lease.fencingToken,
        leaseOwner: "worker-1",
        leaseMs: 60_000,
        now: new Date("2026-08-19T00:00:15.000Z"),
      }),
    ).resolves.toEqual({
      leaseExpiresAt: new Date("2026-08-19T00:01:15.000Z"),
    });
    await expect(
      repository.renewAttempt({
        attemptId: "attempt-1",
        fencingToken: lease.fencingToken,
        leaseOwner: "worker-other",
        leaseMs: 60_000,
        now: new Date("2026-08-19T00:00:30.000Z"),
      }),
    ).rejects.toThrow("run_not_active");
  });

  it("deduplicates effects and rejects stale fencing or changed input", async () => {
    const repository = new MemoryAgentExecutionRepository();
    await repository.accept(acceptance);
    const lease = await repository.claimAttempt({
      attemptId: "attempt-1",
      leaseOwner: "worker-1",
      leaseMs: 10_000,
      now: new Date("2026-08-19T00:00:00.000Z"),
    });
    const request = {
      attemptId: "attempt-1",
      fencingToken: lease.fencingToken,
      inputDigest: "input-1",
      logicalToolCallId: "tool-call-1",
      runId: "run-1",
    };
    await expect(repository.beginEffect(request)).resolves.toEqual({
      status: "reserved",
    });
    await repository.completeEffect({ ...request, result: { jobId: "job-1" } });
    await expect(repository.beginEffect(request)).resolves.toEqual({
      status: "completed",
      result: { jobId: "job-1" },
    });
    await expect(
      repository.beginEffect({ ...request, inputDigest: "input-other" }),
    ).rejects.toThrow("agent_effect_conflict");
    await expect(
      repository.beginEffect({ ...request, fencingToken: 0 }),
    ).rejects.toThrow("run_not_active");
  });

  it("atomically fences effects when cancellation wins", async () => {
    const repository = new MemoryAgentExecutionRepository();
    await repository.accept(acceptance);
    const lease = await repository.claimAttempt({
      attemptId: "attempt-1",
      leaseOwner: "worker-1",
      leaseMs: 10_000,
      now: new Date("2026-08-19T00:00:00.000Z"),
    });
    await repository.cancelAttempt({
      attemptId: "attempt-1",
      fencingToken: lease.fencingToken,
    });
    await expect(
      repository.beginEffect({
        attemptId: "attempt-1",
        fencingToken: lease.fencingToken,
        inputDigest: "input-1",
        logicalToolCallId: "tool-call-1",
        runId: "run-1",
      }),
    ).rejects.toThrow("run_not_active");
  });

  it("atomically finalizes the run and current attempt once", async () => {
    const repository = new MemoryAgentExecutionRepository();
    await repository.accept(acceptance);
    const lease = await repository.claimAttempt({
      attemptId: "attempt-1",
      leaseOwner: "worker-1",
      leaseMs: 10_000,
      now: new Date("2026-08-19T00:00:00.000Z"),
    });

    const completed = await repository.finalizeRun({
      attemptId: "attempt-1",
      fencingToken: lease.fencingToken,
      metadata: {},
      runId: "run-1",
      status: "completed",
    });
    const repeated = await repository.finalizeRun({
      attemptId: "attempt-1",
      fencingToken: lease.fencingToken,
      metadata: {},
      runId: "run-1",
      status: "completed",
    });
    const losingCancel = await repository.finalizeRun({
      attemptId: "attempt-1",
      fencingToken: lease.fencingToken,
      metadata: {},
      runId: "run-1",
      status: "canceled",
    });

    expect(repeated).toEqual(completed);
    expect(losingCancel).toEqual(completed);
    expect(repository.get("run-1")).toMatchObject({
      runStatus: "completed",
      attempt: {
        status: "completed",
        completedAt: completed.completedAt,
      },
    });
  });

  it("rejects stale or non-current finalization", async () => {
    const repository = new MemoryAgentExecutionRepository();
    await repository.accept(acceptance);
    const lease = await repository.claimAttempt({
      attemptId: "attempt-1",
      leaseOwner: "worker-1",
      leaseMs: 10_000,
      now: new Date("2026-08-19T00:00:00.000Z"),
    });

    await expect(
      repository.finalizeRun({
        attemptId: "attempt-other",
        fencingToken: lease.fencingToken,
        metadata: {},
        runId: "run-1",
        status: "failed",
      }),
    ).rejects.toThrow("agent_attempt_not_current");
    await expect(
      repository.finalizeRun({
        attemptId: "attempt-1",
        fencingToken: lease.fencingToken + 1,
        metadata: {},
        runId: "run-1",
        status: "failed",
      }),
    ).rejects.toThrow("run_not_active");
  });

  it("resumes only with the active catalog and reduced capabilities", async () => {
    const repository = new MemoryAgentExecutionRepository();
    await repository.accept(acceptance);
    await expect(
      repository.resumeAttempt({
        runId: "run-1",
        attemptId: "attempt-2",
        activeCatalogDigest: "catalog-other",
        currentCapabilities: ["image.generate"],
        capabilityPolicyVersion: "policy-2",
        effectiveSkillNames: [],
      }),
    ).rejects.toThrow("skill_catalog_changed");
    const resumed = await repository.resumeAttempt({
      runId: "run-1",
      attemptId: "attempt-2",
      activeCatalogDigest: "catalog-1",
      currentCapabilities: ["image.generate", "video.generate"],
      capabilityPolicyVersion: "policy-2",
      effectiveSkillNames: [],
    });
    expect(resumed.capabilities).toEqual(["image.generate"]);
    expect(resumed.effectiveSkillNames).toEqual([]);
    expect(resumed.attemptId).toBe("attempt-2");
  });

  it("never expands built-in Skill authority while resuming", async () => {
    const repository = new MemoryAgentExecutionRepository();
    await repository.accept(acceptance);

    const resumed = await repository.resumeAttempt({
      runId: "run-1",
      attemptId: "attempt-2",
      activeCatalogDigest: "catalog-1",
      currentCapabilities: ["image.generate"],
      capabilityPolicyVersion: "policy-2",
      effectiveSkillNames: ["json-image-prompt", "unapproved-skill"],
    });

    expect(resumed.effectiveSkillNames).toEqual(["json-image-prompt"]);
  });
});

describe("Supabase Agent acceptance adapter", () => {
  it("passes cancellation to the acceptance RPC", async () => {
    const result = abortableResult({
      data: [{ created: true, run_id: "run-1" }],
      error: null,
    });
    const rpc = vi.fn(() => result.builder);
    const repository = createAgentExecutionRepository({
      getAdminClient: () => ({ rpc }) as never,
    });
    const controller = new AbortController();

    await repository.accept(acceptance, controller.signal);

    expect(result.abortSignal).toHaveBeenCalledWith(controller.signal);
  });

  it.each(["57014", "55P03", "40001", "40P01"])(
    "classifies PostgreSQL %s as a definitive retryable rollback",
    async (code) => {
      const result = abortableResult({
        data: null,
        error: { code, message: "sensitive database detail" },
      });
      const repository = createAgentExecutionRepository({
        getAdminClient: () => ({ rpc: vi.fn(() => result.builder) }) as never,
      });

      await expect(repository.accept(acceptance)).rejects.toMatchObject({
        kind: "definitive_unavailable",
        message: "agent_acceptance_unavailable",
      });
    },
  );

  it("classifies the idempotency conflict without exposing database text", async () => {
    const result = abortableResult({
      data: null,
      error: {
        code: "P0001",
        message: "agent_acceptance_conflict: sentinel detail",
      },
    });
    const repository = createAgentExecutionRepository({
      getAdminClient: () => ({ rpc: vi.fn(() => result.builder) }) as never,
    });

    const error = await repository.accept(acceptance).catch((cause) => cause);
    expect(error).toMatchObject({
      kind: "conflict",
      message: "agent_acceptance_conflict",
    });
    expect(String(error)).not.toContain("sentinel detail");
  });

  it("treats transport rejection and malformed success as indeterminate", async () => {
    const rejected = abortableResult(undefined, new Error("socket reset"));
    const malformed = abortableResult({ data: { created: true }, error: null });
    const rejectedRepository = createAgentExecutionRepository({
      getAdminClient: () => ({ rpc: vi.fn(() => rejected.builder) }) as never,
    });
    const malformedRepository = createAgentExecutionRepository({
      getAdminClient: () => ({ rpc: vi.fn(() => malformed.builder) }) as never,
    });

    await expect(rejectedRepository.accept(acceptance)).rejects.toMatchObject({
      kind: "indeterminate",
    });
    await expect(malformedRepository.accept(acceptance)).rejects.toMatchObject({
      kind: "indeterminate",
    });
  });

  it("looks up a durable acceptance using the indexed identity", async () => {
    const result = abortableResult({
      data: {
        id: "run-1",
        model: "openai:persisted-model",
        request_digest: "digest-1",
      },
      error: null,
    });
    const query = queryChain(result.builder);
    const from = vi.fn(() => query);
    const repository = createAgentExecutionRepository({
      getAdminClient: () => ({ from }) as never,
    });
    const controller = new AbortController();

    await expect(
      repository.findAcceptance({
        clientRequestId: "request-1",
        signal: controller.signal,
        userId: "user-1",
      }),
    ).resolves.toEqual({
      model: "openai:persisted-model",
      requestDigest: "digest-1",
      runId: "run-1",
    });
    expect(from).toHaveBeenCalledWith("agent_runs");
    expect(query.select).toHaveBeenCalledWith("id, request_digest, model");
    expect(query.eq).toHaveBeenNthCalledWith(1, "user_id", "user-1");
    expect(query.eq).toHaveBeenNthCalledWith(
      2,
      "client_request_id",
      "request-1",
    );
    expect(query.abortSignal).toHaveBeenCalledWith(controller.signal);
  });

  it("passes atomic finalization to the canonical RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        completedAt: "2026-08-19T00:00:03.000Z",
        status: "failed",
      },
      error: null,
    });
    const repository = createAgentExecutionRepository({
      getAdminClient: () => ({ rpc }) as never,
    });

    await expect(
      repository.finalizeRun({
        attemptId: "attempt-1",
        fencingToken: 3,
        metadata: { errorCode: "tool_failed" },
        runId: "run-1",
        status: "failed",
      }),
    ).resolves.toEqual({
      completedAt: new Date("2026-08-19T00:00:03.000Z"),
      status: "failed",
    });
    expect(rpc).toHaveBeenCalledWith("finalize_agent_run", {
      p_attempt_id: "attempt-1",
      p_fencing_token: 3,
      p_metadata: { errorCode: "tool_failed" },
      p_run_id: "run-1",
      p_status: "failed",
    });
  });

  it("renews an attempt through the fenced lease RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ lease_expires_at: "2026-08-19T00:01:15.000Z" }],
      error: null,
    });
    const repository = createAgentExecutionRepository({
      getAdminClient: () => ({ rpc }) as never,
    });

    await expect(
      repository.renewAttempt({
        attemptId: "attempt-1",
        fencingToken: 3,
        leaseOwner: "worker-1",
        leaseMs: 60_000,
        now: new Date("2026-08-19T00:00:15.000Z"),
      }),
    ).resolves.toEqual({
      leaseExpiresAt: new Date("2026-08-19T00:01:15.000Z"),
    });
    expect(rpc).toHaveBeenCalledWith("renew_agent_run_attempt", {
      p_attempt_id: "attempt-1",
      p_fencing_token: 3,
      p_lease_owner: "worker-1",
      p_lease_ms: 60_000,
    });
  });

  it("recovers expired runs through the bounded canonical RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        {
          runId: "11111111-1111-4111-8111-111111111111",
          attemptId: "22222222-2222-4222-8222-222222222222",
          status: "failed",
        },
      ],
      error: null,
    });
    const repository = createAgentExecutionRepository({
      getAdminClient: () => ({ rpc }) as never,
    });
    const now = new Date("2026-08-20T00:00:00.000Z");

    await expect(
      repository.recoverExpiredRuns({ graceMs: 30_000, limit: 25, now }),
    ).resolves.toEqual([
      {
        runId: "11111111-1111-4111-8111-111111111111",
        attemptId: "22222222-2222-4222-8222-222222222222",
        status: "failed",
      },
    ]);
    expect(rpc).toHaveBeenCalledWith("recover_expired_agent_runs", {
      p_grace_ms: 30_000,
      p_limit: 25,
      p_now: now.toISOString(),
    });
  });

  it("rejects malformed expired-run recovery output", async () => {
    const repository = createAgentExecutionRepository({
      getAdminClient: () =>
        ({
          rpc: vi.fn().mockResolvedValue({
            data: [{ runId: "not-a-uuid", status: "failed" }],
            error: null,
          }),
        }) as never,
    });

    await expect(
      repository.recoverExpiredRuns({
        graceMs: 30_000,
        limit: 25,
        now: new Date("2026-08-20T00:00:00.000Z"),
      }),
    ).rejects.toThrow("agent_execution_persistence_failed");
  });
});

function abortableResult(
  value: unknown,
  rejection?: unknown,
): {
  abortSignal: ReturnType<typeof vi.fn>;
  builder: AbortableTestResult;
} {
  const abortSignal = vi.fn();
  const builder = (
    rejection === undefined ? Promise.resolve(value) : Promise.reject(rejection)
  ) as AbortableTestResult;
  builder.abortSignal = abortSignal;
  abortSignal.mockReturnValue(builder);
  return { abortSignal, builder };
}

type AbortableTestResult = Promise<unknown> & {
  abortSignal(signal: AbortSignal): AbortableTestResult;
};

function queryChain(terminal: unknown) {
  const query = {
    abortSignal: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn(),
    select: vi.fn(),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.abortSignal.mockReturnValue(query);
  query.maybeSingle.mockReturnValue(terminal);
  return query;
}
