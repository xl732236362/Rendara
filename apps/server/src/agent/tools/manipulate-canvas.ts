import { createHash } from "node:crypto";
import { tool } from "langchain";

import type { ApplyCanvasOperations } from "../../application/canvas/apply-canvas-operations.js";
import {
  manipulateCanvasSchema,
  measureTextWidth,
} from "../../features/canvas/canvas-operation-engine.js";

export { measureTextWidth };

export function createManipulateCanvasTool(deps: {
  applyCanvasOperations: ApplyCanvasOperations;
  resolveWorkspaceId(context: {
    accessToken: string;
    userId: string;
    canvasId: string;
  }): Promise<string>;
  agentEffect?: {
    runId: string;
    attemptId: string;
    fencingToken: number;
  };
}) {
  return tool(
    async (input, config) => {
      const canvasId = configurableString(config, "canvas_id");
      const accessToken = configurableString(config, "access_token");
      const userId = configurableString(config, "user_id");

      if (!canvasId || !accessToken || !userId) {
        return JSON.stringify({
          error: "no_canvas_context",
          message:
            "This tool requires a canvas context. Ensure the conversation is linked to a canvas.",
        });
      }

      try {
        const workspaceId = await deps.resolveWorkspaceId({
          accessToken,
          userId,
          canvasId,
        });
        const outcome = await deps.applyCanvasOperations(
          { userId, workspaceId, accessToken },
          {
            canvasId,
            operations: input.operations,
            ...(deps.agentEffect
              ? {
                  agentEffect: {
                    ...deps.agentEffect,
                    logicalToolCallId: toolCallId(config),
                    inputDigest: createHash("sha256")
                      .update(stableJson(input))
                      .digest("hex"),
                  },
                }
              : {}),
          },
        );
        return JSON.stringify({
          success: true,
          applied: outcome.applied,
          summary: (outcome.descriptions ?? []).join("; "),
          ...(Object.keys(outcome.createdIds ?? {}).length > 0
            ? { createdIds: outcome.createdIds }
            : {}),
          ...(outcome.errors?.length ? { errors: outcome.errors } : {}),
        });
      } catch (error) {
        if (
          error instanceof Error &&
          "details" in error &&
          typeof error.details === "object" &&
          error.details &&
          "issues" in error.details
        ) {
          return invalidOperationsResult(
            (
              error.details as {
                issues: Array<{ index: number; message: string }>;
              }
            ).issues,
          );
        }
        return JSON.stringify({
          error: "canvas_not_found",
          message: "Canvas not found or access denied.",
        });
      }
    },
    {
      name: "manipulate_canvas",
      description:
        "Manipulate elements on the canvas. Supports: move, resize, delete (cascades to bound text), update_style, update_text (modify text content of any element or its label), add_text, add_shape (with optional label for centered text), add_line (with optional element binding for auto-connected arrows), align, distribute, reorder. Use inspect_canvas first to understand the current layout. Returns created element IDs for subsequent binding.",
      schema: manipulateCanvasSchema,
    },
  );
}

function toolCallId(config: unknown): string {
  if (!config || typeof config !== "object")
    throw new Error("tool_call_id_required");
  const candidate = config as {
    toolCallId?: unknown;
    toolCall?: { id?: unknown };
  };
  const value = candidate.toolCallId ?? candidate.toolCall?.id;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("tool_call_id_required");
  }
  return value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function configurableString(config: unknown, key: string): string | undefined {
  if (!config || typeof config !== "object" || !("configurable" in config))
    return undefined;
  const configurable = config.configurable;
  if (!configurable || typeof configurable !== "object") return undefined;
  const value = (configurable as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function invalidOperationsResult(
  issues: Array<{ index: number; message: string }>,
): string {
  return JSON.stringify({
    error: "invalid_operations",
    message: "Canvas operations were not applied.",
    issues,
  });
}
