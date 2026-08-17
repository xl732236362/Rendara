import type { FastifyInstance, FastifyReply } from "fastify";

import {
  applicationErrorResponseSchema,
  runCancelResponseSchema,
  runCreateRequestSchema,
  runCreateResponseSchema,
  unauthenticatedErrorResponseSchema,
} from "@loomic/shared";

import type { AgentRunService } from "../agent/runtime.js";
import {
  type AgentRunMetadataService,
  AgentRunPersistenceError,
} from "../features/agent-runs/agent-run-service.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import {
  type ThreadService,
  ThreadServiceError,
} from "../features/chat/thread-service.js";
import type { SettingsService } from "../features/settings/settings-service.js";
import {
  type ResourceAuthorization,
  ResourceAuthorizationError,
  requireRunResourceAccess,
} from "../security/resource-authorization.js";
import type { RequestAuthenticator } from "../supabase/user.js";
import {
  parseRequest,
  parseStringParams,
  raiseBoundaryError,
  throwLegacyServiceError,
  throwRouteError,
} from "./route-errors.js";

export async function registerRunRoutes(
  app: FastifyInstance,
  agentRuns: AgentRunService,
  options: {
    agentRunMetadataService?: AgentRunMetadataService;
    auth?: RequestAuthenticator;
    authorization?: ResourceAuthorization;
    settingsService?: SettingsService;
    threadService?: ThreadService;
    viewerService?: ViewerService;
  } = {},
) {
  app.post("/api/agent/runs", async (request, reply) => {
    const payload = parseRequest(runCreateRequestSchema, request.body);
    const authenticatedUser = options.auth
      ? await options.auth.authenticate(request)
      : null;

    if (!authenticatedUser) {
      return sendUnauthorized(reply);
    }

    if (!options.authorization) {
      throw new Error("Resource authorization is not configured.");
    }

    await requireRunResourceAccess(
      options.authorization,
      authenticatedUser,
      payload,
    );

    const sessionThread =
      authenticatedUser && options?.threadService
        ? await options.threadService.resolveOwnedSessionThread(
            authenticatedUser,
            payload.sessionId,
          )
        : null;

    // Resolve per-workspace model if auth context is available
    let model: string | undefined;
    if (authenticatedUser && options.settingsService && options.viewerService) {
      try {
        // Workspace model lookup is optional enrichment; run submission falls
        // back to the server model when settings are temporarily unavailable.
        const viewer =
          await options.viewerService.ensureViewer(authenticatedUser);
        const settings = await options.settingsService.getWorkspaceSettings(
          authenticatedUser,
          viewer.workspace.id,
        );
        model = settings.defaultModel;
      } catch {
        // Fall through to server default model if settings lookup fails
      }
    }

    const response = runCreateResponseSchema.parse(
      agentRuns.createRun(payload, {
        ...(authenticatedUser
          ? {
              accessToken: authenticatedUser.accessToken,
              userId: authenticatedUser.id,
            }
          : {}),
        ...(model ? { model } : {}),
        ...(sessionThread ? { threadId: sessionThread.threadId } : {}),
      }),
    );

    if (sessionThread && options.agentRunMetadataService) {
      await options.agentRunMetadataService.createAcceptedRun({
        ...(model ? { model } : {}),
        runId: response.runId,
        sessionId: payload.sessionId,
        threadId: sessionThread.threadId,
      });
    }

    return reply.code(202).send(response);
  });

  app.post("/api/agent/runs/:runId/cancel", async (request, reply) => {
    const authenticatedUser = options.auth
      ? await options.auth.authenticate(request)
      : null;
    if (!authenticatedUser) {
      return sendUnauthorized(reply);
    }
    if (!options.authorization) {
      throw new Error("Resource authorization is not configured.");
    }

    const { runId } = parseStringParams(request.params, ["runId"]);
    await options.authorization.requireRunAccess(authenticatedUser, runId);
    const canceledRun = agentRuns.cancelRun(runId);

    if (!canceledRun) {
      throwRouteError({
        code: "application_error",
        statusCode: 404,
        message: "Run not found",
      });
    }

    const response = runCancelResponseSchema.parse(canceledRun);
    return reply.code(202).send(response);
  });
}

function sendUnauthorized(reply: FastifyReply) {
  return raiseBoundaryError(
    {
      error: {
        code: "unauthorized",
        message: "Missing or invalid bearer token.",
      },
    },
    401,
  );
}
