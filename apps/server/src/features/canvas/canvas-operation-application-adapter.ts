import type {
  CanvasOperationPorts,
  CanvasOperationPrincipal,
} from "../../application/canvas/apply-canvas-operations.js";
import { canvasOperationOutcomeSchema } from "../../application/canvas/apply-canvas-operations.js";
import type { ResourceAuthorization } from "../../security/resource-authorization.js";
import type { AuthenticatedUser } from "../../supabase/user.js";
import {
  CanvasOperationError,
  applyCanvasOperations,
} from "./canvas-operation-engine.js";
import type { CanvasService } from "./canvas-service.js";

export function createCanvasAuthorizationPort(options: {
  authorization: Pick<ResourceAuthorization, "requireCanvasAccess">;
  toAuthenticatedUser(principal: CanvasOperationPrincipal): AuthenticatedUser;
}): CanvasOperationPorts["authorization"] {
  return {
    requireCanvasAccess: (principal, canvasId) =>
      options.authorization.requireCanvasAccess(
        options.toAuthenticatedUser(principal),
        canvasId,
      ),
  };
}

export function createCanvasServiceOperationPort(options: {
  canvasService: CanvasService;
  toAuthenticatedUser(principal: CanvasOperationPrincipal): AuthenticatedUser;
}): CanvasOperationPorts["operations"] {
  return {
    async apply(command) {
      const user = options.toAuthenticatedUser(command.principal);
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const canvas = await options.canvasService.getCanvas(
          user,
          command.canvasId,
        );
        const outcome = applyCanvasOperations(
          canvas.content,
          command.operations,
        );
        if (
          outcome.issues.length > 0 ||
          outcome.applied !== command.operations.length
        ) {
          throw new CanvasOperationError(outcome.issues);
        }
        const publicOutcome = {
          canvasId: canvas.id,
          applied: outcome.applied,
          descriptions: outcome.descriptions,
          createdIds: outcome.createdIds,
          errors: outcome.errors,
        };
        try {
          const committed = await options.canvasService.saveCanvasContent(
            user,
            command.canvasId,
            canvas.revision,
            outcome.content,
            ...(command.agentEffect
              ? [{ ...command.agentEffect, result: publicOutcome }]
              : []),
          );
          if (committed.replayed) {
            return canvasOperationOutcomeSchema.parse(committed.effectResult);
          }
          return publicOutcome;
        } catch (error) {
          if (!isRevisionConflict(error) || attempt === 3) throw error;
          await new Promise((resolve) => setTimeout(resolve, attempt * 10));
        }
      }
      throw new Error("Canvas operation retry exhausted.");
    },
  };
}

function isRevisionConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { code?: unknown }).code === "canvas_revision_conflict"
  );
}
