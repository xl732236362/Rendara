import { describe, expect, it } from "vitest";

import { MemoryAgentExecutionRepository } from "./agent-execution-repository.js";

const acceptance = {
  clientRequestId: "request-1",
  requestDigest: "digest-1",
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
