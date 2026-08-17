import type { FastifyInstance, FastifyReply } from "fastify";

import {
  applicationErrorResponseSchema,
  projectCreateRequestSchema,
  projectCreateResponseSchema,
  projectListResponseSchema,
  projectUpdateRequestSchema,
  unauthenticatedErrorResponseSchema,
} from "@loomic/shared";

import {
  type ProjectService,
  ProjectServiceError,
} from "../features/projects/project-service.js";
import type { RequestAuthenticator } from "../supabase/user.js";
import {
  parseRequest,
  parseStringParams,
  raiseBoundaryError,
  throwLegacyServiceError,
} from "./route-errors.js";

export async function registerProjectRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    projectService: ProjectService;
  },
) {
  app.get("/api/projects/:projectId", async (request, reply) => {
    const user = await options.auth.authenticate(request);

    if (!user) {
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

    const { projectId } = parseStringParams(request.params, ["projectId"]);
    const project = await options.projectService.getProject(user, projectId);
    return reply.code(200).send({ project });
  });

  app.get("/api/projects", async (request, reply) => {
    const user = await options.auth.authenticate(request);

    if (!user) {
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

    const projects = await options.projectService.listProjects(user);
    return reply.code(200).send(projectListResponseSchema.parse({ projects }));
  });

  app.delete("/api/projects/:projectId", async (request, reply) => {
    const user = await options.auth.authenticate(request);

    if (!user) {
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

    const { projectId } = parseStringParams(request.params, ["projectId"]);
    await options.projectService.archiveProject(user, projectId);
    return reply.code(204).send();
  });

  app.post("/api/projects", async (request, reply) => {
    const user = await options.auth.authenticate(request);

    if (!user) {
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

    const payload = parseRequest(projectCreateRequestSchema, request.body);
    const project = await options.projectService.createProject(user, payload);

    return reply.code(201).send(
      projectCreateResponseSchema.parse({
        project,
      }),
    );
  });

  app.patch("/api/projects/:projectId", async (request, reply) => {
    const user = await options.auth.authenticate(request);

    if (!user) {
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

    const { projectId } = parseStringParams(request.params, ["projectId"]);
    const payload = parseRequest(projectUpdateRequestSchema, request.body);
    await options.projectService.updateProject(user, projectId, payload);

    return reply.code(204).send();
  });

  app.put<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/thumbnail",
    { bodyLimit: 2 * 1024 * 1024 }, // 2 MB for thumbnails
    async (request, reply) => {
      const user = await options.auth.authenticate(request);
      if (!user) {
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

      const file = await request.file();
      if (!file) {
        return raiseBoundaryError(
          {
            error: {
              code: "upload_failed",
              message: "No file uploaded.",
            },
          },
          400,
        );
      }

      const buffer = await file.toBuffer();
      const mimeType = file.mimetype || "image/webp";

      const result = await options.projectService.saveThumbnail(
        user,
        parseStringParams(request.params, ["projectId"]).projectId,
        buffer,
        mimeType,
      );

      return reply.code(200).send(result);
    },
  );
}
