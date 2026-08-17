import { tool } from "langchain";

import {
  applyCanvasOperations,
  manipulateCanvasSchema,
  measureTextWidth,
} from "../../features/canvas/canvas-operation-engine.js";

export { measureTextWidth };

export function createManipulateCanvasTool(deps: {
  createUserClient: (accessToken: string) => any;
}) {
  return tool(
    async (input, config) => {
      const canvasId = (config as any)?.configurable?.canvas_id;
      const accessToken = (config as any)?.configurable?.access_token;

      if (!canvasId || !accessToken) {
        return JSON.stringify({
          error: "no_canvas_context",
          message:
            "This tool requires a canvas context. Ensure the conversation is linked to a canvas.",
        });
      }

      const client = deps.createUserClient(accessToken);
      const { data, error } = await client
        .from("canvases")
        .select("content")
        .eq("id", canvasId)
        .single();
      if (error || !data) {
        return JSON.stringify({
          error: "canvas_not_found",
          message: "Canvas not found or access denied.",
        });
      }

      const outcome = applyCanvasOperations(data.content, input.operations);
      if (outcome.issues.length > 0) {
        return JSON.stringify({
          error: "invalid_operations",
          message: "Canvas operations were not applied.",
          issues: outcome.issues,
        });
      }
      const { error: writeError } = await client
        .from("canvases")
        .update({ content: outcome.content })
        .eq("id", canvasId);
      if (writeError) {
        return JSON.stringify({
          error: "write_failed",
          message: `Failed to save canvas: ${writeError.message}`,
        });
      }

      return JSON.stringify({
        success: true,
        applied: outcome.applied,
        summary: outcome.descriptions.join("; "),
        ...(Object.keys(outcome.createdIds).length > 0
          ? { createdIds: outcome.createdIds }
          : {}),
        ...(outcome.errors.length > 0 ? { errors: outcome.errors } : {}),
      });
    },
    {
      name: "manipulate_canvas",
      description:
        "Manipulate elements on the canvas. Supports: move, resize, delete (cascades to bound text), update_style, update_text (modify text content of any element or its label), add_text, add_shape (with optional label for centered text), add_line (with optional element binding for auto-connected arrows), align, distribute, reorder. Use inspect_canvas first to understand the current layout. Returns created element IDs for subsequent binding.",
      schema: manipulateCanvasSchema,
    },
  );
}
