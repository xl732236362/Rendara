import { AppError } from "../../errors/app-error.js";
import type { UserSupabaseClient } from "../../supabase/user.js";
import type { ReferenceAssetAuthorizationPort } from "./ports.js";

type ReferenceAssetRow = {
  id: string;
  workspace_id: string;
  project_id: string | null;
  mime_type: string;
};

export function createReferenceAssetAuthorizationPort(options: {
  createUserClient(accessToken: string): UserSupabaseClient;
}): ReferenceAssetAuthorizationPort {
  return {
    async authorize({ principal, projectId, assetIds }) {
      if (new Set(assetIds).size !== assetIds.length) {
        throw new AppError({
          code: "invalid_request",
          statusCode: 400,
          message: "Reference asset IDs must be unique.",
          expose: true,
        });
      }
      if (!principal.accessToken) {
        throw new AppError({
          code: "unauthorized",
          statusCode: 401,
          message: "Authentication is required.",
          expose: true,
        });
      }

      const client = options.createUserClient(principal.accessToken);
      const { data, error } = await client
        .from("asset_objects")
        .select("id, workspace_id, project_id, mime_type")
        .in("id", assetIds);
      if (error) {
        throw new AppError({
          code: "application_error",
          statusCode: 500,
          message: "Reference asset lookup failed.",
          cause: error,
        });
      }

      const rows = (data ?? []) as ReferenceAssetRow[];
      const rowsById = new Map(rows.map((row) => [row.id, row]));
      const authorized = assetIds.every((id) => {
        const row = rowsById.get(id);
        return (
          row?.workspace_id === principal.workspaceId &&
          row.project_id === projectId &&
          row.mime_type.startsWith("image/")
        );
      });
      if (rows.length !== assetIds.length || !authorized) {
        throw new AppError({
          code: "forbidden",
          statusCode: 403,
          message: "One or more reference assets are unavailable.",
          expose: true,
        });
      }
    },
  };
}
