import { z } from "zod";

import { AppError } from "../../errors/app-error.js";
import {
  type CanvasOperation,
  CanvasOperationError,
  strictCanvasOperationSchema,
} from "../../features/canvas/canvas-operation-engine.js";
import type { StructuredLogger } from "../generation/ports.js";

const applyCanvasOperationsRequestSchema = z.object({
  canvasId: z.string().trim().min(1),
  operations: z.array(strictCanvasOperationSchema).min(1).max(100),
  agentEffect: z
    .object({
      runId: z.string().min(1),
      attemptId: z.string().min(1),
      fencingToken: z.number().int().nonnegative(),
      logicalToolCallId: z.string().min(1),
      inputDigest: z.string().min(1),
    })
    .optional(),
});

export const canvasOperationOutcomeSchema = z.object({
  canvasId: z.string().min(1),
  applied: z.number().int().nonnegative(),
  descriptions: z.array(z.string()).optional(),
  createdIds: z.record(z.string(), z.string()).optional(),
  errors: z.array(z.string()).optional(),
});

export type ApplyCanvasOperations = ReturnType<
  typeof createApplyCanvasOperations
>;

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
      agentEffect?: z.infer<
        typeof applyCanvasOperationsRequestSchema
      >["agentEffect"];
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
        details: { issues: boundedCanvasIssues(parsed.error.issues) },
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
          ...(request.agentEffect ? { agentEffect: request.agentEffect } : {}),
        }),
      );
      if (outcome.canvasId !== request.canvasId) {
        throw new Error("Canvas operation outcome identity mismatch");
      }
      if (outcome.applied !== request.operations.length) {
        throw new Error("Canvas operation outcome count mismatch");
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

function boundedCanvasIssues(
  issues: z.core.$ZodIssue[],
): Array<{ index: number; message: string }> {
  return issues.slice(0, 20).map((issue) => ({
    index:
      issue.path.find((part): part is number => typeof part === "number") ?? 0,
    message: issue.message.slice(0, 200),
  }));
}

function normalizeCanvasOperationError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof CanvasOperationError) {
    return new AppError({
      code: "invalid_request",
      statusCode: 400,
      message: "Invalid canvas operations.",
      expose: true,
      details: { issues: error.issues },
      cause: error,
    });
  }
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
