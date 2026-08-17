import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import {
  applicationErrorResponseSchema,
  chatMessageCreateRequestSchema,
  messageCreateResponseSchema,
  messageListResponseSchema,
  sessionCreateResponseSchema,
  sessionListResponseSchema,
  unauthenticatedErrorResponseSchema,
} from "@loomic/shared";

import {
  type ChatService,
  ChatServiceError,
} from "../features/chat/chat-service.js";
import type { RequestAuthenticator } from "../supabase/user.js";
import {
  parseRequest,
  parseStringParams,
  raiseBoundaryError,
  throwLegacyServiceError,
} from "./route-errors.js";

const sessionTitleRequestSchema = z.object({
  title: z.string().trim().min(1).optional(),
});

export async function registerChatRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    chatService: ChatService;
  },
) {
  // List sessions for a canvas
  app.get<{ Params: { canvasId: string } }>(
    "/api/canvases/:canvasId/sessions",
    async (request, reply) => {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthorized(reply);

      const { canvasId } = parseStringParams(request.params, ["canvasId"]);
      const sessions = await options.chatService.listSessions(user, canvasId);

      return reply
        .code(200)
        .send(sessionListResponseSchema.parse({ sessions }));
    },
  );

  // Create a new session
  app.post<{ Params: { canvasId: string } }>(
    "/api/canvases/:canvasId/sessions",
    async (request, reply) => {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthorized(reply);

      const body = parseRequest(sessionTitleRequestSchema, request.body ?? {});
      const { canvasId } = parseStringParams(request.params, ["canvasId"]);
      const session = await options.chatService.createSession(
        user,
        canvasId,
        body?.title,
      );

      return reply
        .code(201)
        .send(sessionCreateResponseSchema.parse({ session }));
    },
  );

  // Update session title
  app.patch<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId",
    async (request, reply) => {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthorized(reply);

      const body = parseRequest(sessionTitleRequestSchema, request.body ?? {});
      const { sessionId } = parseStringParams(request.params, ["sessionId"]);
      if (body?.title) {
        await options.chatService.updateSessionTitle(
          user,
          sessionId,
          body.title,
        );
      }

      return reply.code(200).send({ ok: true });
    },
  );

  // Delete a session
  app.delete<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId",
    async (request, reply) => {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthorized(reply);

      const { sessionId } = parseStringParams(request.params, ["sessionId"]);
      await options.chatService.deleteSession(user, sessionId);

      return reply.code(200).send({ ok: true });
    },
  );

  // List messages for a session
  app.get<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId/messages",
    async (request, reply) => {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthorized(reply);

      const { sessionId } = parseStringParams(request.params, ["sessionId"]);
      const messages = await options.chatService.listMessages(user, sessionId);

      request.log.info(
        { sessionId, count: messages.length },
        "chat.listMessages OK",
      );
      return reply
        .code(200)
        .send(messageListResponseSchema.parse({ messages }));
    },
  );

  // Create a message
  app.post<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId/messages",
    { bodyLimit: 10 * 1024 * 1024 }, // 10 MB — messages may include base64 image data from canvas selections
    async (request, reply) => {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthorized(reply);

      const input = parseRequest(chatMessageCreateRequestSchema, request.body);
      const { sessionId } = parseStringParams(request.params, ["sessionId"]);
      const message = await options.chatService.createMessage(
        user,
        sessionId,
        input,
      );

      request.log.info(
        {
          sessionId,
          role: input.role,
          messageId: message.id,
        },
        "chat.createMessage OK",
      );
      return reply
        .code(201)
        .send(messageCreateResponseSchema.parse({ message }));
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
