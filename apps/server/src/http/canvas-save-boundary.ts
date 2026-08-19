import type { CanvasContent } from "@loomic/shared";
import type { FastifyBaseLogger } from "fastify";

import { AppError } from "../errors/app-error.js";
import type { CanvasService } from "../features/canvas/canvas-service.js";
import type { AuthenticatedUser } from "../supabase/user.js";
import { safeRead, safeReadString } from "../utils/safe-error-inspection.js";

type CanvasSaveFailureClassification = "conflict" | "not_found" | "internal";

export async function saveCanvasAtHttpBoundary(options: {
  canvasService: CanvasService;
  user: AuthenticatedUser;
  canvasId: string;
  expectedRevision: number;
  content: CanvasContent;
  correlationId: string;
  log: Pick<FastifyBaseLogger, "error" | "warn">;
}): ReturnType<CanvasService["saveCanvasContent"]> {
  try {
    return await options.canvasService.saveCanvasContent(
      options.user,
      options.canvasId,
      options.expectedRevision,
      options.content,
    );
  } catch (error) {
    const failure = classifyCanvasSaveFailure(error);
    const fields = {
      event: "canvas.save.failed",
      canvasId: options.canvasId,
      expectedRevision: options.expectedRevision,
      stage: "commit",
      errorClassification: failure.classification,
      correlationId: options.correlationId,
    };
    if (failure.statusCode >= 500) {
      options.log.error(fields, "Canvas save failed");
      throw new AppError({
        code: "application_error",
        statusCode: 500,
        message: "Canvas save failed.",
      });
    }
    options.log.warn(fields, "Canvas save rejected");
    throw error;
  }
}

function classifyCanvasSaveFailure(error: unknown): {
  classification: CanvasSaveFailureClassification;
  statusCode: number;
} {
  const code = safeReadString(error, "code");
  const statusCode = safeRead(error, "statusCode");
  if (code === "canvas_revision_conflict" && statusCode === 409) {
    return { classification: "conflict", statusCode: 409 };
  }
  if (code === "canvas_not_found" && statusCode === 404) {
    return { classification: "not_found", statusCode: 404 };
  }
  return { classification: "internal", statusCode: 500 };
}
