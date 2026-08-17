import { z } from "zod";

import { AppError } from "../../errors/app-error.js";
import {
  type CanvasOperation,
  canvasOperationSchema,
} from "../../features/canvas/canvas-operation-engine.js";
import type { StructuredLogger } from "../generation/ports.js";

const applyCanvasOperationsRequestSchema = z.object({
  canvasId: z.string().trim().min(1),
  operations: z.array(canvasOperationSchema).min(1).max(100),
});

const canvasOperationOutcomeSchema = z.object({
  canvasId: z.string().min(1),
  applied: z.number().int().nonnegative(),
});

export type CanvasOperationPrincipal = {
  userId: string;
  workspaceId: string;
  accessToken?: string;
};

export type CurrentCanvasOperation = CanvasOperation;

export type CanvasOperationPorts = {
  authorization: {
    requireCanvasAccess(
      principal: CanvasOperationPrincipal,
      canvasId: string,
    ): Promise<void>;
  };
  operations: {
    /** The adapter owns loading, applying the existing operation handlers, and saving. */
    apply(command: {
      principal: CanvasOperationPrincipal;
      canvasId: string;
      operations: CurrentCanvasOperation[];
    }): Promise<unknown>;
  };
};

export function createApplyCanvasOperations(options: {
  ports: CanvasOperationPorts;
  logger: StructuredLogger;
}) {
  return async (principal: CanvasOperationPrincipal, rawRequest: unknown) => {
    const parsed = applyCanvasOperationsRequestSchema.safeParse(rawRequest);
    if (!parsed.success) {
      throw new AppError({
        code: "invalid_request",
        statusCode: 400,
        message: "Invalid canvas operation request.",
        expose: true,
        details: { issues: parsed.error.issues },
      });
    }

    const request = parsed.data;
    let stage = "authorization";
    try {
      await options.ports.authorization.requireCanvasAccess(
        principal,
        request.canvasId,
      );
      stage = "operation_application";
      const outcome = canvasOperationOutcomeSchema.parse(
        await options.ports.operations.apply({
          principal,
          canvasId: request.canvasId,
          operations: request.operations,
        }),
      );
      if (outcome.canvasId !== request.canvasId) {
        throw new Error("Canvas operation outcome identity mismatch");
      }

      options.logger.info("Canvas operations applied", {
        applied: outcome.applied,
        canvasId: request.canvasId,
        operationCount: request.operations.length,
        userId: principal.userId,
        workspaceId: principal.workspaceId,
      });
      return outcome;
    } catch (error) {
      const normalized = normalizeCanvasOperationError(error);
      options.logger.error("Canvas operation failed", {
        canvasId: request.canvasId,
        errorCode: normalized.code,
        operationCount: request.operations.length,
        stage,
        userId: principal.userId,
        workspaceId: principal.workspaceId,
      });
      throw normalized;
    }
  };
}

function normalizeCanvasOperationError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (
    error instanceof Error &&
    "code" in error &&
    "statusCode" in error &&
    error.code === "forbidden" &&
    error.statusCode === 403
  ) {
    return new AppError({
      code: "forbidden",
      statusCode: 403,
      message: "Access denied.",
      expose: true,
      cause: error,
    });
  }
  return new AppError({
    code: "application_error",
    statusCode: 500,
    message: "Canvas operation failed.",
    cause: error,
  });
}
