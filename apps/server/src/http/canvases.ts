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
      try {
        const user = await options.auth.authenticate(request);
        if (!user) return sendUnauthorized(reply);
        const canvas = await options.canvasService.getCanvas(
          user,
          request.params.canvasId,
        );
        return reply.code(200).send(canvasGetResponseSchema.parse({ canvas }));
      } catch (error) {
        return sendCanvasError(error, reply);
      }
    },
  );

  app.put<{ Params: { canvasId: string } }>(
    "/api/canvases/:canvasId",
    { bodyLimit: 50 * 1024 * 1024 }, // 50 MB — canvas content includes base64 image data
    async (request, reply) => {
      try {
        const user = await options.auth.authenticate(request);
        if (!user) return sendUnauthorized(reply);
        const payload = parseRequest(canvasSaveRequestSchema, request.body);
        await options.canvasService.saveCanvasContent(
          user,
          request.params.canvasId,
          payload.content,
        );
        const bodySize = JSON.stringify(request.body).length;
        request.log.info(
          { canvasId: request.params.canvasId, bodyBytes: bodySize },
          "canvas.save OK",
        );
        return reply
          .code(200)
          .send(canvasSaveResponseSchema.parse({ ok: true }));
      } catch (error) {
        request.log.error(
          { canvasId: request.params.canvasId, err: error },
          "canvas.save FAILED",
        );
        return sendCanvasError(error, reply);
      }
    },
  );
}

function sendUnauthorized(reply: FastifyReply) {
  return reply.code(401).send(
    raiseBoundaryError({
      error: {
        code: "unauthorized",
        message: "Missing or invalid bearer token.",
      },
    }),
  );
}

function sendCanvasError(error: unknown, reply: FastifyReply) {
  throwLegacyServiceError(error);
}
