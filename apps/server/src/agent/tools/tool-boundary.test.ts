import { ToolMessage } from "@langchain/core/messages";
import { tool } from "langchain";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { MemoryAgentExecutionRepository } from "../../features/agent-runs/agent-execution-repository.js";
import { ProviderRegistry } from "../../generation/providers/registry.js";
import type { AgentExecutionContext } from "../execution-context.js";
import {
  GeneratedAssetAttachmentError,
  generatedMediaToolResultSchema,
} from "../generated-media-result.js";
import { createImageGenerateTool } from "./image-generate.js";
import { guardToolCall } from "./tool-guard.js";

const context: AgentExecutionContext = {
  attemptId: "attempt-1",
  canvasId: "canvas-1",
  capabilities: ["canvas.read", "canvas.mutate"],
  capabilityPolicyVersion: "policy-1",
  effectiveSkillNames: [],
  projectId: "project-1",
  runId: "run-1",
  skillCatalogDigest: "catalog-1",
  userId: "user-1",
  workspaceId: "workspace-1",
};

async function repository() {
  const result = new MemoryAgentExecutionRepository();
  await result.accept({
    clientRequestId: "request-1",
    context,
    requestDigest: "digest-1",
  });
  return result;
}

describe("Agent tool boundary", () => {
  it("rechecks the active attempt and capability for every invocation", async () => {
    const repo = await repository();
    await expect(
      guardToolCall({
        capability: "canvas.read",
        context,
        input: {},
        invoke: async () => ({ ok: true }),
        repository: repo,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      guardToolCall({
        capability: "image.generate",
        context,
        input: {},
        invoke: async () => ({ ok: true }),
        repository: repo,
      }),
    ).rejects.toThrow("capability_denied");
    await expect(
      guardToolCall({
        capability: "canvas.read",
        context: { ...context, attemptId: "stale-attempt" },
        input: {},
        invoke: async () => ({ ok: true }),
        repository: repo,
      }),
    ).rejects.toThrow("run_not_active");
  });

  it("does not release a tool result after the attempt is canceled in flight", async () => {
    const repo = await repository();
    const lease = await repo.claimAttempt({
      attemptId: context.attemptId,
      leaseOwner: "worker-1",
      leaseMs: 60_000,
      now: new Date(),
    });

    await expect(
      guardToolCall({
        capability: "canvas.read",
        context,
        fencingToken: lease.fencingToken,
        input: {},
        invoke: async () => {
          await repo.cancelAttempt({
            attemptId: context.attemptId,
            fencingToken: lease.fencingToken,
          });
          return { secret: "must-not-escape" };
        },
        repository: repo,
      }),
    ).rejects.toThrow("run_not_active");
  });

  it("revalidates current resource authorization before releasing results", async () => {
    const repo = await repository();
    const authorize = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error("canvas_access_denied"));
    await expect(
      guardToolCall({
        capability: "canvas.read",
        context,
        input: {},
        invoke: async () => ({ private: true }),
        repository: repo,
        authorize,
      }),
    ).rejects.toThrow("canvas_access_denied");
    expect(authorize).toHaveBeenCalledTimes(2);
  });

  it("denies a capability removed by the current deployment policy", async () => {
    const repo = await repository();
    await expect(
      guardToolCall({
        capability: "canvas.read",
        context,
        input: {},
        invoke: async () => ({ private: true }),
        repository: repo,
        resolveCurrentCapabilities: () => ["canvas.mutate"],
      }),
    ).rejects.toThrow("capability_denied");
  });

  it("rejects scope authority, raw locations and oversized inputs", async () => {
    const repo = await repository();
    const invoke = async () => "ok";
    for (const input of [
      { canvasId: "other" },
      { nested: { project_id: "other" } },
      { source: "https://example.com/input.png" },
      { objectKey: "bucket/object.png" },
    ]) {
      await expect(
        guardToolCall({
          capability: "canvas.read",
          context,
          input,
          invoke,
          repository: repo,
        }),
      ).rejects.toThrow("tool_not_authorized");
    }
    await expect(
      guardToolCall({
        capability: "canvas.read",
        context,
        input: { text: "x".repeat(256 * 1024) },
        invoke,
        repository: repo,
      }),
    ).rejects.toThrow("tool_input_too_large");
  });

  it("limits canvas operations, output bytes and records", async () => {
    const repo = await repository();
    await expect(
      guardToolCall({
        capability: "canvas.mutate",
        context,
        input: {
          operations: Array.from({ length: 101 }, () => ({ type: "x" })),
        },
        invoke: async () => "ok",
        repository: repo,
      }),
    ).rejects.toThrow("tool_input_too_large");
    await expect(
      guardToolCall({
        capability: "canvas.read",
        context,
        input: {},
        invoke: async () => "x".repeat(64 * 1024 + 1),
        repository: repo,
      }),
    ).rejects.toThrow("tool_result_too_large");
    await expect(
      guardToolCall({
        capability: "canvas.read",
        context,
        input: {},
        invoke: async () => Array.from({ length: 101 }, (_, id) => ({ id })),
        repository: repo,
      }),
    ).rejects.toThrow("tool_result_too_large");
    await expect(
      guardToolCall({
        capability: "canvas.read",
        context,
        input: {},
        invoke: async () =>
          JSON.stringify(Array.from({ length: 101 }, (_, id) => ({ id }))),
        repository: repo,
      }),
    ).rejects.toThrow("tool_result_too_large");
  });

  it("tool schemas do not accept caller-owned scope fields", () => {
    const schema = z.object({ query: z.string() }).strict();
    const bounded = tool(async () => "ok", {
      name: "bounded",
      description: "bounded",
      schema,
    });
    expect(
      bounded.schema.safeParse({ query: "x", canvasId: "canvas-other" })
        .success,
    ).toBe(false);
    const imageTool = createImageGenerateTool({
      providerRegistry: new ProviderRegistry().seal(),
    });
    expect(
      imageTool.schema.safeParse({
        title: "image",
        prompt: "prompt",
        model: "model",
        inputImages: ["https://example.com/raw.png"],
      }).success,
    ).toBe(false);
  });

  it("passes the stable LangChain tool-call ID to generation submission", async () => {
    const jobId = "11111111-1111-4111-8111-111111111111";
    const submitImageJob = vi.fn(async () => ({
      attachmentStatus: "not_requested" as const,
      jobId,
      artifact: {
        type: "image" as const,
        title: "Image",
        source: { kind: "asset" as const, assetId: jobId },
        url: `/api/assets/${jobId}`,
        mimeType: "image/png",
        width: 1024,
        height: 1024,
        jobId,
      },
    }));
    const imageTool = createImageGenerateTool({
      providerRegistry: new ProviderRegistry().seal(),
      submitImageJob,
    });

    const args = {
      title: "Image",
      prompt: "prompt",
      model: "model",
    };
    await imageTool.invoke(args, {
      toolCall: {
        type: "tool_call",
        id: "tool-call-stable",
        name: "generate_image",
        args,
      },
    } as never);

    expect(submitImageJob).toHaveBeenCalledWith(
      expect.objectContaining({ logicalToolCallId: "tool-call-stable" }),
    );
  });

  it("returns attached proof through LangChain content_and_artifact", async () => {
    const jobId = "11111111-1111-4111-8111-111111111111";
    const toolCallId = "tool-call-attached";
    const artifact = {
      type: "image" as const,
      title: "Image",
      source: { kind: "asset" as const, assetId: jobId },
      url: `/api/assets/${jobId}`,
      mimeType: "image/png",
      width: 1024,
      height: 768,
      jobId,
    };
    const imageTool = createImageGenerateTool({
      providerRegistry: new ProviderRegistry().seal(),
      submitImageJob: async () => ({
        attachmentStatus: "attached",
        jobId,
        elementId: jobId,
        canvasRevision: 12,
        artifact,
      }),
    });

    const result = await imageTool.invoke({
      type: "tool_call",
      id: toolCallId,
      name: "generate_image",
      args: { title: "Image", prompt: "prompt", model: "model" },
    });

    expect(ToolMessage.isInstance(result)).toBe(true);
    expect(result).toMatchObject({
      status: "success",
      tool_call_id: toolCallId,
      artifact: {
        attachmentStatus: "attached",
        elementId: jobId,
        canvasRevision: 12,
        artifact,
      },
    });
    expect(String(result.content)).toContain("attached to the canvas");
  });

  it("does not claim attachment for generate-only jobs", async () => {
    const jobId = "11111111-1111-4111-8111-111111111111";
    const imageTool = createImageGenerateTool({
      providerRegistry: new ProviderRegistry().seal(),
      submitImageJob: async () => ({
        attachmentStatus: "not_requested",
        jobId,
        artifact: {
          type: "image",
          source: { kind: "asset", assetId: jobId },
          url: `/api/assets/${jobId}`,
          mimeType: "image/png",
          width: 100,
          height: 100,
          jobId,
        },
      }),
    });
    const result = await imageTool.invoke({
      type: "tool_call",
      id: "tool-call-generate-only",
      name: "generate_image",
      args: { title: "Image", prompt: "prompt", model: "model" },
    });
    expect(String(result.content)).not.toContain("attached");
    expect(result).toMatchObject({
      artifact: { attachmentStatus: "not_requested" },
    });
  });

  it("throws a typed attachment error for pending and failed intents", async () => {
    const jobId = "11111111-1111-4111-8111-111111111111";
    const canvasId = "22222222-2222-4222-8222-222222222222";
    for (const attachmentStatus of ["pending", "not_attached"] as const) {
      const recoveryKind =
        attachmentStatus === "pending"
          ? "watch_generated_asset"
          : "attach_generated_asset";
      const imageTool = createImageGenerateTool({
        providerRegistry: new ProviderRegistry().seal(),
        submitImageJob: async () => ({
          attachmentStatus,
          jobId,
          recovery: { kind: recoveryKind, jobId, canvasId },
          error: {
            code:
              attachmentStatus === "pending"
                ? "generated_asset_pending"
                : "generated_asset_not_attached",
            message:
              attachmentStatus === "pending"
                ? "Generated media is still being attached."
                : "Generated media was not attached.",
            retryable: true,
          },
        }),
      });
      const error = await imageTool
        .invoke({
          type: "tool_call",
          id: `tool-call-${attachmentStatus}`,
          name: "generate_image",
          args: { title: "Image", prompt: "prompt", model: "model" },
        })
        .catch((value: unknown) => value);
      expect(error).toBeInstanceOf(GeneratedAssetAttachmentError);
    }
  });

  it("rejects unsafe or arbitrary generated media artifacts", () => {
    const jobId = "11111111-1111-4111-8111-111111111111";
    expect(
      generatedMediaToolResultSchema.safeParse({
        attachmentStatus: "not_requested",
        jobId,
        artifact: {
          type: "image",
          url: "data:image/png;base64,secret",
          mimeType: "image/png",
          width: 1,
          height: 1,
        },
      }).success,
    ).toBe(false);
    expect(
      generatedMediaToolResultSchema.safeParse({
        attachmentStatus: "not_requested",
        jobId,
        artifact: { type: "private_payload", secret: "x" },
      }).success,
    ).toBe(false);
  });
});
