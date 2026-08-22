import type { FastifyInstance, FastifyReply } from "fastify";

import {
  applicationErrorResponseSchema,
  brandKitAssetCreateRequestSchema,
  brandKitAssetResponseSchema,
  brandKitAssetUpdateRequestSchema,
  brandKitCreateRequestSchema,
  brandKitDetailResponseSchema,
  brandKitListResponseSchema,
  brandKitSummarySchema,
  brandKitUpdateRequestSchema,
  createCursorPageSchema,
  paginationQuerySchema,
  unauthenticatedErrorResponseSchema,
} from "@loomic/shared";

import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import {
  type BrandKitService,
  BrandKitServiceError,
} from "../features/brand-kit/brand-kit-service.js";
import type { RequestAuthenticator } from "../supabase/user.js";
import {
  parseRequest,
  parseStringParams,
  raiseBoundaryError,
  throwLegacyServiceError,
} from "./route-errors.js";

const ALLOWED_UPLOAD_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/svg+xml",
]);
const brandKitPageSchema = createCursorPageSchema(brandKitSummarySchema);

type BrandKitErrorFallbackCode =
  | "brand_kit_not_found"
  | "brand_kit_create_failed"
  | "brand_kit_update_failed"
  | "brand_kit_delete_failed"
  | "brand_kit_query_failed"
  | "brand_kit_asset_not_found"
  | "brand_kit_asset_create_failed";

export async function registerBrandKitRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    brandKitService: BrandKitService;
    viewerService: ViewerService;
  },
) {
  app.get("/api/v2/brand-kits", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) return sendUnauthenticated(reply);

    const query = parseRequest(paginationQuerySchema, request.query);
    const viewer = await options.viewerService.ensureViewer(user);
    const page = await options.brandKitService.listKitsPage(
      user,
      viewer.workspace.id,
      query,
    );
    return reply.code(200).send(brandKitPageSchema.parse(page));
  });

  // GET /api/brand-kits — list kits
  app.get("/api/brand-kits", async (request, reply) => {
    const user = await options.auth.authenticate(request);

    if (!user) {
      return sendUnauthenticated(reply);
    }

    const brandKits = await options.brandKitService.listKits(user);
    return reply
      .code(200)
      .send(brandKitListResponseSchema.parse({ brandKits }));
  });

  // POST /api/brand-kits — create kit
  app.post("/api/brand-kits", async (request, reply) => {
    const user = await options.auth.authenticate(request);

    if (!user) {
      return sendUnauthenticated(reply);
    }

    const payload = parseRequest(brandKitCreateRequestSchema, request.body);
    const kit = await options.brandKitService.createKit(user, payload);

    return reply.code(201).send(brandKitDetailResponseSchema.parse(kit));
  });

  // GET /api/brand-kits/:kitId — get detail
  app.get("/api/brand-kits/:kitId", async (request, reply) => {
    const user = await options.auth.authenticate(request);

    if (!user) {
      return sendUnauthenticated(reply);
    }

    const { kitId } = parseStringParams(request.params, ["kitId"]);
    const kit = await options.brandKitService.getKit(user, kitId);

    return reply.code(200).send(brandKitDetailResponseSchema.parse(kit));
  });

  // PATCH /api/brand-kits/:kitId — update kit
  app.patch("/api/brand-kits/:kitId", async (request, reply) => {
    const user = await options.auth.authenticate(request);

    if (!user) {
      return sendUnauthenticated(reply);
    }

    const { kitId } = parseStringParams(request.params, ["kitId"]);
    const payload = parseRequest(brandKitUpdateRequestSchema, request.body);
    const kit = await options.brandKitService.updateKit(user, kitId, payload);

    return reply.code(200).send(brandKitDetailResponseSchema.parse(kit));
  });

  // POST /api/brand-kits/:kitId/duplicate — duplicate kit
  app.post("/api/brand-kits/:kitId/duplicate", async (request, reply) => {
    const user = await options.auth.authenticate(request);

    if (!user) {
      return sendUnauthenticated(reply);
    }

    const { kitId } = parseStringParams(request.params, ["kitId"]);
    const kit = await options.brandKitService.duplicateKit(user, kitId);

    return reply.code(201).send(brandKitDetailResponseSchema.parse(kit));
  });

  // DELETE /api/brand-kits/:kitId — delete kit
  app.delete("/api/brand-kits/:kitId", async (request, reply) => {
    const user = await options.auth.authenticate(request);

    if (!user) {
      return sendUnauthenticated(reply);
    }

    const { kitId } = parseStringParams(request.params, ["kitId"]);
    await options.brandKitService.deleteKit(user, kitId);

    return reply.code(204).send();
  });

  // POST /api/brand-kits/:kitId/assets/upload — upload file asset (logo/image)
  app.post("/api/brand-kits/:kitId/assets/upload", async (request, reply) => {
    const user = await options.auth.authenticate(request);

    if (!user) {
      return sendUnauthenticated(reply);
    }

    const { kitId } = parseStringParams(request.params, ["kitId"]);

    const file = await request.file();
    if (!file) {
      return raiseBoundaryError(
        {
          error: {
            code: "brand_kit_asset_create_failed",
            message: "No file provided.",
          },
        },
        400,
      );
    }

    const mimeType = file.mimetype;
    if (!ALLOWED_UPLOAD_MIME_TYPES.has(mimeType)) {
      return raiseBoundaryError(
        {
          error: {
            code: "brand_kit_asset_create_failed",
            message: `Unsupported file type: ${mimeType}. Allowed: ${[...ALLOWED_UPLOAD_MIME_TYPES].join(", ")}`,
          },
        },
        400,
      );
    }

    // Extract asset_type from multipart fields
    const assetTypeField = file.fields.asset_type;
    const assetType =
      typeof assetTypeField === "object" &&
      assetTypeField !== null &&
      "value" in assetTypeField
        ? String(assetTypeField.value)
        : undefined;

    if (assetType !== "logo" && assetType !== "image") {
      return raiseBoundaryError(
        {
          error: {
            code: "brand_kit_asset_create_failed",
            message: "asset_type must be 'logo' or 'image'.",
          },
        },
        400,
      );
    }

    const fileBuffer = await file.toBuffer();
    const asset = await options.brandKitService.uploadAsset(
      user,
      kitId,
      assetType,
      file.filename,
      fileBuffer,
      mimeType,
    );

    return reply.code(201).send(brandKitAssetResponseSchema.parse(asset));
  });

  // POST /api/brand-kits/:kitId/assets — create asset
  app.post("/api/brand-kits/:kitId/assets", async (request, reply) => {
    const user = await options.auth.authenticate(request);

    if (!user) {
      return sendUnauthenticated(reply);
    }

    const { kitId } = parseStringParams(request.params, ["kitId"]);
    const payload = parseRequest(
      brandKitAssetCreateRequestSchema,
      request.body,
    );
    const asset = await options.brandKitService.createAsset(
      user,
      kitId,
      payload,
    );

    return reply.code(201).send(brandKitAssetResponseSchema.parse(asset));
  });

  // PATCH /api/brand-kits/:kitId/assets/:assetId — update asset
  app.patch(
    "/api/brand-kits/:kitId/assets/:assetId",
    async (request, reply) => {
      const user = await options.auth.authenticate(request);

      if (!user) {
        return sendUnauthenticated(reply);
      }

      const { kitId, assetId } = parseStringParams(request.params, [
        "kitId",
        "assetId",
      ]);
      const payload = parseRequest(
        brandKitAssetUpdateRequestSchema,
        request.body,
      );
      const asset = await options.brandKitService.updateAsset(
        user,
        kitId,
        assetId,
        payload,
      );

      return reply.code(200).send(brandKitAssetResponseSchema.parse(asset));
    },
  );

  // DELETE /api/brand-kits/:kitId/assets/:assetId — delete asset
  app.delete(
    "/api/brand-kits/:kitId/assets/:assetId",
    async (request, reply) => {
      const user = await options.auth.authenticate(request);

      if (!user) {
        return sendUnauthenticated(reply);
      }

      const { kitId, assetId } = parseStringParams(request.params, [
        "kitId",
        "assetId",
      ]);
      await options.brandKitService.deleteAsset(user, kitId, assetId);

      return reply.code(204).send();
    },
  );
}

function sendUnauthenticated(reply: FastifyReply) {
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
