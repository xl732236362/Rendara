import type { FastifyInstance, FastifyReply } from "fastify";

import {
  applicationErrorResponseSchema,
  runCancelResponseSchema,
  runCreateRequestSchema,
  runCreateResponseSchema,
  unauthenticatedErrorResponseSchema,
} from "@loomic/shared";

import type { AgentRunService } from "../agent/runtime.js";
import type { PrepareAgentRun } from "../application/agent/prepare-agent-run.js";
import {
  type AgentRunMetadataService,
  AgentRunPersistenceError,
} from "../features/agent-runs/agent-run-service.js";
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
    prepareAgentRun?: PrepareAgentRun;
    agentRunMetadataService?: AgentRunMetadataService;
    auth?: RequestAuthenticator;
    authorization?: ResourceAuthorization;
  },
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

    if (!options.prepareAgentRun) {
      throw new Error("Agent preparation is not configured.");
    }
    const prepared = await options.prepareAgentRun(
      payload,
      {
        userId: authenticatedUser.id,
        accessToken: authenticatedUser.accessToken,
      },
      { requestId: request.id },
    );
    const response = runCreateResponseSchema.parse(
      agentRuns.registerRun(payload, {
        accessToken: authenticatedUser.accessToken,
        durableCreated: prepared.accepted.created,
        runId: prepared.accepted.runId,
        userId: authenticatedUser.id,
        ...(prepared.model ? { model: prepared.model } : {}),
        threadId: prepared.context.threadId,
      }).response,
    );

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
    const canceledRun = await agentRuns.cancelRun(runId);

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
