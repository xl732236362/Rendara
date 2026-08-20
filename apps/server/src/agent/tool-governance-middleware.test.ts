import { ToolMessage } from "@langchain/core/messages";
import { tool } from "langchain";
import { MiddlewareError } from "langchain";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { MemoryAgentExecutionRepository } from "../features/agent-runs/agent-execution-repository.js";
import type { AgentExecutionContext } from "./execution-context.js";
import { GeneratedAssetAttachmentError } from "./generated-media-result.js";
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

  it("projects a validated generated-media artifact only from a successful ToolMessage", async () => {
    const { request, supervisor, wrapToolCall } = await harness();
    const jobId = "11111111-1111-4111-8111-111111111111";
    const result = new ToolMessage({
      content: "Generated media is ready.",
      name: "inspect_canvas",
      status: "success",
      tool_call_id: "model-call-1",
      artifact: {
        attachmentStatus: "not_requested",
        jobId,
        artifact: {
          type: "image",
          source: { kind: "asset", assetId: jobId },
          url: `/api/assets/${jobId}`,
          mimeType: "image/png",
          width: 512,
          height: 512,
          jobId,
        },
      },
    });

    await expect(
      wrapToolCall(request as never, async () => result),
    ).resolves.toBe(result);

    expect(supervisor.records().at(-1)).toMatchObject({
      type: "loomic.tool.completed",
      outputSummary: "Generated media is ready.",
      artifacts: [expect.objectContaining({ type: "image", jobId })],
    });
  });

  it("does not expose arbitrary successful ToolMessage artifacts", async () => {
    const { request, supervisor, wrapToolCall } = await harness();
    const result = new ToolMessage({
      content: "Legacy direct-generation result.",
      name: "inspect_canvas",
      status: "success",
      tool_call_id: "model-call-1",
      artifact: {
        imageUrl: "https://example.com/legacy.png",
        mimeType: "image/png",
      },
    });

    await expect(
      wrapToolCall(request as never, async () => result),
    ).resolves.toBe(result);

    expect(supervisor.records().at(-1)).toMatchObject({
      type: "loomic.tool.completed",
      outputSummary: "Legacy direct-generation result.",
    });
    expect(supervisor.records().at(-1)).not.toHaveProperty("artifacts");
  });

  it("turns a returned pending generated-media result into the attachment failure path", async () => {
    const { request, supervisor, wrapToolCall } = await harness();
    const jobId = "11111111-1111-4111-8111-111111111111";
    const canvasId = "22222222-2222-4222-8222-222222222222";
    const result = new ToolMessage({
      content: "Generated media is still being attached.",
      name: "inspect_canvas",
      status: "success",
      tool_call_id: "model-call-1",
      artifact: {
        attachmentStatus: "pending",
        jobId,
        recovery: { kind: "attach_generated_asset", jobId, canvasId },
        error: {
          code: "generated_asset_attachment_pending",
          message: "Generated media is still being attached.",
          retryable: true,
        },
      },
    });

    const returned = await wrapToolCall(request as never, async () => result);

    expect(returned).toMatchObject({
      status: "error",
      artifact: {
        type: "loomic.tool_error",
        code: "generated_asset_attachment_pending",
        recovery: { kind: "attach_generated_asset", jobId, canvasId },
      },
    });
    expect(supervisor.records().at(-1)).toMatchObject({
      type: "loomic.tool.failed",
      error: { code: "generated_asset_attachment_pending" },
    });
  });

  it("preserves typed placement failures as bounded tool errors", async () => {
    const { request, supervisor, wrapToolCall } = await harness();
    const failure = Object.assign(
      new Error("Relative image placement requires the attachment backend."),
      { code: "relative_placement_requires_attachment_backend" },
    );

    const returned = await wrapToolCall(request as never, async () => {
      throw failure;
    });

    expect(returned).toMatchObject({
      status: "error",
      artifact: {
        type: "loomic.tool_error",
        code: "relative_placement_requires_attachment_backend",
      },
    });
    expect(supervisor.records().at(-1)).toMatchObject({
      type: "loomic.tool.failed",
      error: { code: "relative_placement_requires_attachment_backend" },
    });
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

  it("drops invalid image artifacts before projecting a recoverable failure", async () => {
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
        artifacts: [
          {
            type: "image",
            source: {
              kind: "asset",
              assetId: "11111111-1111-4111-8111-111111111111",
            },
            url: "https://example.com/conflicting-image.png",
            mimeType: "image/png",
            width: 512,
            height: 512,
          },
          {
            type: "video",
            url: "https://example.com/generated.mp4",
            mimeType: "video/mp4",
            width: 1920,
            height: 1080,
          },
        ],
      },
    });

    await expect(
      wrapToolCall(request as never, async () => result),
    ).resolves.toBe(result);
    expect(supervisor.records().at(-1)).toMatchObject({
      type: "loomic.tool.failed",
      error: { code: "element_not_found" },
      artifacts: [expect.objectContaining({ type: "video" })],
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

  it("turns a typed attachment failure into one safe error ToolMessage", async () => {
    const { request, supervisor, wrapToolCall } = await harness();
    const jobId = "11111111-1111-4111-8111-111111111111";
    const canvasId = "22222222-2222-4222-8222-222222222222";
    const error = new GeneratedAssetAttachmentError({
      attachmentStatus: "not_attached",
      jobId,
      recovery: {
        kind: "attach_generated_asset",
        jobId,
        canvasId,
      },
      error: {
        code: "generated_asset_not_attached",
        message: "Generated media was not attached.",
        retryable: true,
      },
      artifact: {
        type: "image",
        source: { kind: "asset", assetId: jobId },
        url: `/api/assets/${jobId}`,
        mimeType: "image/png",
        width: 100,
        height: 100,
        jobId,
      },
    });

    const result = await wrapToolCall(request as never, async () => {
      throw error;
    });

    expect(ToolMessage.isInstance(result)).toBe(true);
    expect(result).toMatchObject({
      status: "error",
      artifact: {
        type: "loomic.tool_error",
        recovery: { kind: "attach_generated_asset", jobId, canvasId },
      },
    });
    expect(supervisor.records().at(-1)).toMatchObject({
      type: "loomic.tool.failed",
      error: { code: "generated_asset_not_attached" },
      recovery: { kind: "attach_generated_asset", jobId, canvasId },
      artifacts: [expect.objectContaining({ type: "image", jobId })],
    });
  });
});
