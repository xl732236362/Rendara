import {
  type PaginationQuery,
  createCursorPageSchema,
  projectSummarySchema,
} from "@loomic/shared";

import { apiFetch } from "../api-client";

const projectPageSchema = createCursorPageSchema(projectSummarySchema);

export function fetchProjectsPage(
  accessToken: string,
  page: Partial<PaginationQuery>,
  options: { signal?: AbortSignal } = {},
) {
  return apiFetch({
    method: "GET",
    path: paginationPath("/api/v2/projects", page),
    accessToken,
    responseSchema: projectPageSchema,
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

export function paginationPath(
  path: string,
  page: Partial<PaginationQuery>,
): string {
  const query = new URLSearchParams();
  if (page.cursor) query.set("cursor", page.cursor);
  if (page.limit !== undefined) query.set("limit", String(page.limit));
  const suffix = query.toString();
  return suffix ? `${path}?${suffix}` : path;
}
