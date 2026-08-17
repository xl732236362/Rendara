import type { FastifyInstance, FastifyReply } from "fastify";

import {
  applicationErrorResponseSchema,
  canvasGetResponseSchema,
  canvasSaveRequestSchema,
  canvasSaveResponseSchema,
  unauthenticatedErrorResponseSchema,
} from "@loomic/shared";

import {
  type CanvasService,
  CanvasServiceError,
} from "../features/canvas/canvas-service.js";
import type { RequestAuthenticator } from "../supabase/user.js";
import {
  parseRequest,
  parseStringParams,
  raiseBoundaryError,
  throwLegacyServiceError,
} from "./route-errors.js";

export async function registerCanvasRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    canvasService: CanvasService;
  },
) {
  app.get<{ Params: { canvasId: string } }>(
    "/api/canvases/:canvasId",
    async (request, reply) => {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthorized(reply);
      const { canvasId } = parseStringParams(request.params, ["canvasId"]);
      const canvas = await options.canvasService.getCanvas(user, canvasId);
      return reply.code(200).send(canvasGetResponseSchema.parse({ canvas }));
    },
  );

  app.put<{ Params: { canvasId: string } }>(
    "/api/canvases/:canvasId",
    { bodyLimit: 50 * 1024 * 1024 }, // 50 MB — canvas content includes base64 image data
    async (request, reply) => {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthorized(reply);
      const payload = parseRequest(canvasSaveRequestSchema, request.body);
      const { canvasId } = parseStringParams(request.params, ["canvasId"]);
      await options.canvasService.saveCanvasContent(
        user,
        canvasId,
        payload.content,
      );
      const bodySize = JSON.stringify(request.body).length;
      request.log.info({ canvasId, bodyBytes: bodySize }, "canvas.save OK");
      return reply.code(200).send(canvasSaveResponseSchema.parse({ ok: true }));
    },
  );
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
