import { viewerResponseSchema } from "@loomic/shared";

import { apiFetch } from "../api-client";

export function fetchViewer(
  accessToken: string,
  options: { signal?: AbortSignal } = {},
) {
  return apiFetch({
    method: "GET",
    path: "/api/viewer",
    accessToken,
    responseSchema: viewerResponseSchema,
    ...(options.signal ? { signal: options.signal } : {}),
  });
}
