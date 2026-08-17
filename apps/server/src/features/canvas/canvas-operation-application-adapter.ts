import type { CanvasContent } from "@loomic/shared";

import type {
  CanvasOperationPorts,
  CanvasOperationPrincipal,
  CurrentCanvasOperation,
} from "../../application/canvas/apply-canvas-operations.js";
import type { ResourceAuthorization } from "../../security/resource-authorization.js";
import type { AuthenticatedUser } from "../../supabase/user.js";
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
  applyOperations(
    content: CanvasContent,
    operations: CurrentCanvasOperation[],
  ):
    | { content: CanvasContent; applied: number }
    | Promise<{ content: CanvasContent; applied: number }>;
}): CanvasOperationPorts["operations"] {
  return {
    async apply(command) {
      const user = options.toAuthenticatedUser(command.principal);
      const canvas = await options.canvasService.getCanvas(
        user,
        command.canvasId,
      );
      const outcome = await options.applyOperations(
        canvas.content,
        command.operations,
      );
      await options.canvasService.saveCanvasContent(
        user,
        command.canvasId,
        outcome.content,
      );
      return { canvasId: canvas.id, applied: outcome.applied };
    },
  };
}
