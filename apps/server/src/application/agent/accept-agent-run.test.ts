import { describe, expect, it, vi } from "vitest";

import { createAgentAuthority } from "../../agent/capabilities.js";
import { MemoryAgentExecutionRepository } from "../../features/agent-runs/agent-execution-repository.js";
import { createAcceptAgentRun } from "./accept-agent-run.js";

const request = {
  canvasId: "canvas-1",
  clientRequestId: "request-1",
  conversationId: "conversation-1",
  prompt: "Create an image",
  sessionId: "session-1",
};

function createSubject() {
  const repository = new MemoryAgentExecutionRepository();
  const resolveScope = vi.fn(async () => ({
    canvasId: "canvas-1",
    projectId: "project-1",
    workspaceId: "workspace-1",
  }));
  const requireSessionScope = vi.fn(async () => ({
    projectId: "project-1",
    workspaceId: "workspace-1",
  }));
  const accept = createAcceptAgentRun({
    catalog: {
      digest: "catalog-digest",
      list: () => [
        { name: "json-image-prompt", requiredCapabilities: ["image.generate"] },
      ],
    },
    repository,
    resolveAuthority: () =>
      createAgentAuthority(["image.generate", "skill.read"]),
    resolveScope,
    requireSessionScope,
    runIdFactory: () => "run-1",
    attemptIdFactory: () => "attempt-1",
  });
  return { accept, repository, requireSessionScope, resolveScope };
}

describe("AcceptAgentRun", () => {
  it("persists canonical canvas scope and effective authority before returning", async () => {
    const { accept, repository } = createSubject();

    const result = await accept(request, { userId: "user-1" });

    expect(result).toEqual({ runId: "run-1", status: "accepted" });
    expect(repository.get("run-1")?.context).toMatchObject({
      attemptId: "attempt-1",
      canvasId: "canvas-1",
      projectId: "project-1",
      workspaceId: "workspace-1",
      userId: "user-1",
      effectiveSkillNames: ["json-image-prompt"],
      skillCatalogDigest: "catalog-digest",
    });
    expect(repository.get("run-1")?.outbox).toHaveLength(1);
  });

  it("rejects a session outside the canonical canvas scope", async () => {
    const { accept, requireSessionScope } = createSubject();
    requireSessionScope.mockResolvedValueOnce({
      projectId: "project-other",
      workspaceId: "workspace-1",
    });

    await expect(accept(request, { userId: "user-1" })).rejects.toThrow(
      "session_canvas_mismatch",
    );
  });

  it("returns one run for an identical idempotent acceptance", async () => {
    const { accept, repository } = createSubject();

    const first = await accept(request, { userId: "user-1" });
    const second = await accept(request, { userId: "user-1" });

    expect(second).toEqual(first);
    expect(repository.size).toBe(1);
  });

  it("rejects reuse of a client request id with different canonical input", async () => {
    const { accept } = createSubject();
    await accept(request, { userId: "user-1" });

    await expect(
      accept({ ...request, prompt: "Different" }, { userId: "user-1" }),
    ).rejects.toThrow("agent_acceptance_conflict");
  });
});
