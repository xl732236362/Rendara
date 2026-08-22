import {
  type PaginationQuery,
  chatMessageSchema,
  chatSessionSummarySchema,
  createCursorPageSchema,
} from "@loomic/shared";

import { apiFetch } from "../api-client";
import { paginationPath } from "./projects";

const chatSessionPageSchema = createCursorPageSchema(chatSessionSummarySchema);
const chatMessagePageSchema = createCursorPageSchema(chatMessageSchema);

export function fetchChatSessionsPage(
  accessToken: string,
  canvasId: string,
  page: Partial<PaginationQuery>,
  options: { signal?: AbortSignal } = {},
) {
  return apiFetch({
    method: "GET",
    path: paginationPath(
      `/api/v2/canvases/${encodeURIComponent(canvasId)}/sessions`,
      page,
    ),
    accessToken,
    responseSchema: chatSessionPageSchema,
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

export function fetchChatMessagesPage(
  accessToken: string,
  sessionId: string,
  page: Partial<PaginationQuery>,
  options: { signal?: AbortSignal } = {},
) {
  return apiFetch({
    method: "GET",
    path: paginationPath(
      `/api/v2/sessions/${encodeURIComponent(sessionId)}/messages`,
      page,
    ),
    accessToken,
    responseSchema: chatMessagePageSchema,
    ...(options.signal ? { signal: options.signal } : {}),
  });
}
