import {
  type PaginationQuery,
  brandKitSummarySchema,
  createCursorPageSchema,
} from "@loomic/shared";

import { apiFetch } from "../api-client";
import { paginationPath } from "./projects";

const brandKitPageSchema = createCursorPageSchema(brandKitSummarySchema);

export function fetchBrandKitsPage(
  accessToken: string,
  page: Partial<PaginationQuery>,
  options: { signal?: AbortSignal } = {},
) {
  return apiFetch({
    method: "GET",
    path: paginationPath("/api/v2/brand-kits", page),
    accessToken,
    responseSchema: brandKitPageSchema,
    ...(options.signal ? { signal: options.signal } : {}),
  });
}
