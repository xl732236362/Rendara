import { ToolMessage } from "@langchain/core/messages";
import { tool } from "langchain";
import { MiddlewareError } from "langchain";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { MemoryAgentExecutionRepository } from "../features/agent-runs/agent-execution-repository.js";
import type { AgentExecutionContext } from "./execution-context.js";
import { createToolExecutionSupervisor } from "./tool-execution-supervisor.js";
import {
  LoomicToolBoundaryError,
  createToolGovernanceMiddleware,
  isLoomicToolBoundaryError,
} from "./tool-governance-middleware.js";

const context: AgentExecutionContext = {
  attemptId: "attempt-1",
  canvasId: "canvas-1",
  capabilities: ["canvas.read"],
  capabilityPolicyVersion: "policy-1",
  effectiveSkillNames: [],
  projectId: "project-1",
  runId: "run-1",
  skillCatalogDigest: "catalog-1",
  userId: "user-1",
  workspaceId: "workspace-1",
};

async function harness() {
  const repository = new MemoryAgentExecutionRepository();
  await repository.accept({
    clientRequestId: "request-1",
    context,
    requestDigest: "request-digest-1",
  });
  const lease = await repository.claimAttempt({
    attemptId: context.attemptId,
    leaseMs: 60_000,
    leaseOwner: "worker-1",
    now: new Date(),
  });
  const supervisor = createToolExecutionSupervisor({
    agentRunId: context.runId,
    attemptId: context.attemptId,
    maxBytes: 64_000,
    maxCalls: 4,
  });
  const middleware = createToolGovernanceMiddleware({
    context,
    fencingToken: lease.fencingToken,
    publish: async (record) => {
      supervisor.acknowledge(record);
    },
    repository,
    resolveCurrentCapabilities: () => ["canvas.read"],
    supervisor,
  });
  const registeredTool = tool(async () => "unused", {
    name: "inspect_canvas",
    description: "Inspect the canvas.",
    schema: z.object({ mode: z.string() }),
  });
  const request = {
    tool: registeredTool,
    toolCall: {
      type: "tool_call" as const,
      id: "model-call-1",
      name: "inspect_canvas",
      args: { mode: "summary" },
    },
    state: { messages: [] },
    runtime: { signal: new AbortController().signal },
  };
  const wrapToolCall = middleware.wrapToolCall;
  if (!wrapToolCall) throw new Error("Expected wrapToolCall middleware.");
  return { request, supervisor, wrapToolCall };
}

describe("tool governance middleware", () => {
  it("uses the model tool-call ID and invokes the framework handler once", async () => {
    const { request, supervisor, wrapToolCall } = await harness();
    const result = new ToolMessage({
      content: "Canvas has two elements.",
      name: "inspect_canvas",
      status: "success",
      tool_call_id: "model-call-1",
    });
    const handler = vi.fn(async () => result);

    await expect(wrapToolCall(request as never, handler)).resolves.toBe(result);

    expect(handler).toHaveBeenCalledOnce();
    expect(supervisor.records()).toEqual([
      expect.objectContaining({
        type: "loomic.tool.started",
        logicalToolCallId: "model-call-1",
      }),
      expect.objectContaining({
        type: "loomic.tool.completed",
        logicalToolCallId: "model-call-1",
      }),
    ]);
  });

  it("projects a returned error ToolMessage as failed without ending correction", async () => {
    const { request, supervisor, wrapToolCall } = await harness();
    const result = new ToolMessage({
      content: "The requested element does not exist.",
      name: "inspect_canvas",
      status: "error",
      tool_call_id: "model-call-1",
      artifact: {
        type: "loomic.tool_error",
        code: "element_not_found",
        message: "The requested element does not exist.",
        correlationId: "correlation-1",
      },
    });

    await expect(
      wrapToolCall(request as never, async () => result),
    ).resolves.toBe(result);
    expect(supervisor.records().at(-1)).toMatchObject({
      type: "loomic.tool.failed",
      error: { code: "element_not_found" },
    });
  });

  it("preserves the original cause in a branded boundary failure", async () => {
    const { request, supervisor, wrapToolCall } = await harness();
    const infrastructureFailure = new Error("database_unavailable");

    const thrown = await Promise.resolve(
      wrapToolCall(request as never, async () => {
        throw infrastructureFailure;
      }),
    ).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(LoomicToolBoundaryError);
    expect(isLoomicToolBoundaryError(thrown)).toBe(true);
    expect((thrown as Error).cause).toBe(infrastructureFailure);
    expect(supervisor.records().at(-1)).toMatchObject({
      type: "loomic.tool.failed",
      logicalToolCallId: "model-call-1",
    });

    const frameworkWrapped = MiddlewareError.wrap(
      thrown,
      "LoomicToolGovernance",
    );
    expect(frameworkWrapped).toBeInstanceOf(MiddlewareError);
    expect(MiddlewareError.isInstance(frameworkWrapped)).toBe(false);
    expect(frameworkWrapped.cause).toBe(thrown);
  });

  it("rejects a missing logical ID before publishing or invoking", async () => {
    const { request, supervisor, wrapToolCall } = await harness();
    const handler = vi.fn();

    await expect(
      wrapToolCall(
        {
          ...request,
          toolCall: { ...request.toolCall, id: "" },
        } as never,
        handler,
      ),
    ).rejects.toThrow("tool_call_id_required");
    expect(handler).not.toHaveBeenCalled();
    expect(supervisor.records()).toEqual([]);
  });
});
