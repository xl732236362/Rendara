import type { FastifyInstance, FastifyReply } from "fastify";

import {
  applicationErrorResponseSchema,
  assetSignedUrlResponseSchema,
  unauthenticatedErrorResponseSchema,
  uploadResponseSchema,
} from "@loomic/shared";

import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import {
  type UploadService,
  UploadServiceError,
} from "../features/uploads/upload-service.js";
import type { RequestAuthenticator } from "../supabase/user.js";
import {
  parseStringParams,
  raiseBoundaryError,
  throwLegacyServiceError,
} from "./route-errors.js";

const ALLOWED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/svg+xml",
]);

export async function registerUploadRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    uploadService: UploadService;
    viewerService: ViewerService;
  },
) {
  // Upload a file
  app.post("/api/uploads", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) return sendUnauthorized(reply);

    const file = await request.file();
    if (!file) {
      return raiseBoundaryError(
        {
          error: {
            code: "upload_failed",
            message: "No file provided.",
          },
        },
        400,
      );
    }

    const mimeType = file.mimetype;
    if (!ALLOWED_MIME_TYPES.has(mimeType)) {
      return raiseBoundaryError(
        {
          error: {
            code: "upload_failed",
            message: `Unsupported file type: ${mimeType}. Allowed: ${[...ALLOWED_MIME_TYPES].join(", ")}`,
          },
        },
        400,
      );
    }

    const fileBuffer = await file.toBuffer();

    // Resolve workspace from viewer
    const viewer = await options.viewerService.ensureViewer(user);
    const workspaceId = viewer.workspace.id;

    // Extract projectId from fields if provided
    const projectId =
      typeof file.fields.projectId === "object" &&
      file.fields.projectId !== null &&
      "value" in file.fields.projectId
        ? String(file.fields.projectId.value)
        : undefined;

    const result = await options.uploadService.uploadFile(user, {
      bucket: "project-assets",
      fileName: file.filename,
      fileBuffer,
      mimeType,
      workspaceId,
      ...(projectId ? { projectId } : {}),
    });

    return reply.code(201).send(uploadResponseSchema.parse(result));
  });

  // Get signed URL for an asset
  app.get<{ Params: { assetId: string } }>(
    "/api/uploads/:assetId/url",
    async (request, reply) => {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthorized(reply);

      const { assetId } = parseStringParams(request.params, ["assetId"]);
      const url = await options.uploadService.getAssetUrl(user, assetId);

      return reply.code(200).send(assetSignedUrlResponseSchema.parse({ url }));
    },
  );

  // Delete an asset
  app.delete<{ Params: { assetId: string } }>(
    "/api/uploads/:assetId",
    async (request, reply) => {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthorized(reply);

      const { assetId } = parseStringParams(request.params, ["assetId"]);
      await options.uploadService.deleteAsset(user, assetId);

      return reply.code(200).send({ ok: true });
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
