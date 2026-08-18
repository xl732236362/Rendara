import { tool } from "langchain";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { MemoryAgentExecutionRepository } from "../../features/agent-runs/agent-execution-repository.js";
import { ProviderRegistry } from "../../generation/providers/registry.js";
import type { AgentExecutionContext } from "../execution-context.js";
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
});
