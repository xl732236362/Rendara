import { describe, expect, it, vi } from "vitest";

import { createAgentAuthority } from "../../agent/capabilities.js";
import { MemoryAgentExecutionRepository } from "../../features/agent-runs/agent-execution-repository.js";
import {
  createAcceptAgentRun,
  createAgentRunRequestDigest,
} from "./accept-agent-run.js";
import type { AuthorizedAgentRunContext } from "./authorized-run-context.js";

const request = {
  canvasId: "canvas-1",
  clientRequestId: "request-1",
  conversationId: "conversation-1",
  prompt: "Create an image",
  sessionId: "session-1",
};

const context: AuthorizedAgentRunContext = Object.freeze({
  accessToken: "current-token",
  canvasId: "canvas-1",
  conversationId: "conversation-1",
  projectId: "project-1",
  sessionId: "session-1",
  threadId: "thread-1",
  userId: "user-1",
  workspaceId: "workspace-1",
});

function createSubject() {
  const repository = new MemoryAgentExecutionRepository();
  const repositoryAccept = vi.spyOn(repository, "accept");
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
    runIdFactory: () => "run-1",
    attemptIdFactory: () => "attempt-1",
  });
  return { accept, repository, repositoryAccept };
}

describe("AcceptAgentRun", () => {
  it("persists the pre-authorized scope and effective authority once", async () => {
    const { accept, repository, repositoryAccept } = createSubject();
    const requestDigest = createAgentRunRequestDigest(request, context);
    const controller = new AbortController();

    const result = await accept({
      context,
      model: "openai:test-model",
      request,
      requestDigest,
      signal: controller.signal,
    });

    expect(result).toEqual({
      created: true,
      requestDigest,
      runId: "run-1",
      status: "accepted",
    });
    expect(repositoryAccept).toHaveBeenCalledOnce();
    expect(repositoryAccept.mock.calls[0]?.[1]).toBe(controller.signal);
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

  it("builds a stable digest without the in-memory access token", () => {
    const first = createAgentRunRequestDigest(request, context);
    const refreshedToken = createAgentRunRequestDigest(request, {
      ...context,
      accessToken: "refreshed-token",
    });
    const reorderedRequest = createAgentRunRequestDigest(
      {
        sessionId: "session-1",
        prompt: "Create an image",
        conversationId: "conversation-1",
        clientRequestId: "request-1",
        canvasId: "canvas-1",
      },
      context,
    );

    expect(refreshedToken).toBe(first);
    expect(reorderedRequest).toBe(first);
    expect(
      createAgentRunRequestDigest({ ...request, prompt: "Different" }, context),
    ).not.toBe(first);
  });

  it("returns one run for an identical idempotent acceptance", async () => {
    const { accept, repository } = createSubject();
    const input = {
      context,
      request,
      requestDigest: createAgentRunRequestDigest(request, context),
    };

    const first = await accept(input);
    const second = await accept(input);

    expect(second).toEqual({ ...first, created: false });
    expect(repository.size).toBe(1);
  });

  it("rejects reuse of a client request id with different canonical input", async () => {
    const { accept } = createSubject();
    const requestDigest = createAgentRunRequestDigest(request, context);
    await accept({ context, request, requestDigest });

    const changedRequest = { ...request, prompt: "Different" };
    await expect(
      accept({
        context,
        request: changedRequest,
        requestDigest: createAgentRunRequestDigest(changedRequest, context),
      }),
    ).rejects.toMatchObject({ kind: "conflict" });
  });
});
