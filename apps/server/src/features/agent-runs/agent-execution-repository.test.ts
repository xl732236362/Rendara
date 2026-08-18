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
});
