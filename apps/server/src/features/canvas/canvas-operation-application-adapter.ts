import type {
  CanvasOperationPorts,
  CanvasOperationPrincipal,
} from "../../application/canvas/apply-canvas-operations.js";
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
      const canvas = await options.canvasService.getCanvas(
        user,
        command.canvasId,
      );
      const outcome = applyCanvasOperations(canvas.content, command.operations);
      if (
        outcome.issues.length > 0 ||
        outcome.applied !== command.operations.length
      ) {
        throw new CanvasOperationError(outcome.issues);
      }
      await options.canvasService.saveCanvasContent(
        user,
        command.canvasId,
        outcome.content,
      );
      return {
        canvasId: canvas.id,
        applied: outcome.applied,
        descriptions: outcome.descriptions,
        createdIds: outcome.createdIds,
        errors: outcome.errors,
      };
    },
  };
}
