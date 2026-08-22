import {
  imageModelListResponseSchema,
  modelListResponseSchema,
  videoModelListResponseSchema,
} from "@loomic/shared";

import { apiFetch } from "../api-client";

type ModelRequestOptions = { accessToken?: string; signal?: AbortSignal };

export function fetchAgentModels(options: { signal?: AbortSignal } = {}) {
  return apiFetch({
    method: "GET",
    path: "/api/models",
    responseSchema: modelListResponseSchema,
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

export function fetchImageModels(options: ModelRequestOptions = {}) {
  return fetchModelCatalog(
    "/api/image-models",
    imageModelListResponseSchema,
    options,
  );
}

export function fetchVideoModels(options: ModelRequestOptions = {}) {
  return fetchModelCatalog(
    "/api/video-models",
    videoModelListResponseSchema,
    options,
  );
}

function fetchModelCatalog<T>(
  path: string,
  responseSchema: import("zod").ZodType<T>,
  options: ModelRequestOptions,
) {
  return apiFetch({
    method: "GET",
    path,
    responseSchema,
    ...(options.accessToken ? { accessToken: options.accessToken } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}
