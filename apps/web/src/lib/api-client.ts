import { type BoundaryErrorCode, errorEnvelopeSchema } from "@loomic/shared";
import type { ZodType } from "zod";

import { getServerBaseUrl } from "./env";
import { notifyApiAuthExpired } from "./auth-expiry";

const DEFAULT_TIMEOUT_MS = 30_000;

export class ApiProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiProtocolError";
  }
}

export class ApiApplicationError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;
  readonly status: number;

  constructor(
    code: string,
    message: string,
    options: { details?: Record<string, unknown>; status?: number } = {},
  ) {
    super(message);
    this.name = "ApiApplicationError";
    this.code = code;
    this.details = options.details;
    this.status = options.status ?? 500;
  }
}

export class ApiAuthError extends ApiApplicationError {
  constructor(message = "unauthorized") {
    super("unauthorized", message, { status: 401 });
    this.name = "ApiAuthError";
  }
}

export class ApiTimeoutError extends ApiApplicationError {
  constructor() {
    super("request_timeout", "Request timed out", { status: 408 });
    this.name = "ApiTimeoutError";
  }
}

export class ApiAbortError extends ApiApplicationError {
  constructor() {
    super("request_aborted", "Request was aborted", { status: 499 });
    this.name = "ApiAbortError";
  }
}

type ApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

type ApiFetchBaseOptions<TRequest> = {
  method: ApiMethod;
  path: string;
  accessToken?: string;
  requestSchema?: ZodType<TRequest>;
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
  headers?: HeadersInit;
};

type ApiFetchJsonOptions<TRequest, TResponse> =
  ApiFetchBaseOptions<TRequest> & {
    responseSchema: ZodType<TResponse>;
    responseMode?: "json";
  };

type ApiFetchEmptyOptions<TRequest> = ApiFetchBaseOptions<TRequest> & {
  responseMode: "empty";
  responseSchema?: never;
};

export function apiFetch<TRequest = never, TResponse = never>(
  options: ApiFetchJsonOptions<TRequest, TResponse>,
): Promise<TResponse>;
export function apiFetch<TRequest = never>(
  options: ApiFetchEmptyOptions<TRequest>,
): Promise<void>;
export async function apiFetch<TRequest, TResponse>(
  options:
    | ApiFetchJsonOptions<TRequest, TResponse>
    | ApiFetchEmptyOptions<TRequest>,
): Promise<TResponse | undefined> {
  const request = prepareRequest(options);
  const abort = composeAbortSignal(options.signal, options.timeoutMs);

  try {
    const init: RequestInit = {
      method: options.method,
      headers: request.headers,
      signal: abort.signal,
    };
    if (request.body !== undefined) init.body = request.body;
    const response = await fetch(buildApiUrl(options.path), init);

    if (!response.ok) {
      return await throwResponseError(response);
    }
    if (options.responseMode === "empty") {
      return undefined;
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ApiProtocolError("API returned malformed JSON");
    }

    const parsed = options.responseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ApiProtocolError("API returned an invalid response");
    }
    return parsed.data;
  } catch (error) {
    if (abort.didTimeout()) {
      throw new ApiTimeoutError();
    }
    if (abort.wasCallerAbort()) {
      throw new ApiAbortError();
    }
    throw error;
  } finally {
    abort.cleanup();
  }
}

function buildApiUrl(path: string) {
  let baseUrl: URL;
  try {
    baseUrl = new URL(getServerBaseUrl());
  } catch {
    throw new ApiProtocolError("API base URL is invalid");
  }
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    throw new ApiProtocolError("API base URL is invalid");
  }

  baseUrl.search = "";
  baseUrl.hash = "";
  const base = baseUrl.toString().replace(/\/+$/, "");
  const relativePath = path.replace(/^\/+/, "");
  return `${base}/${relativePath}`;
}

function prepareRequest<TRequest>(options: ApiFetchBaseOptions<TRequest>) {
  const headers = new Headers(options.headers);
  if (options.accessToken) {
    headers.set("authorization", `Bearer ${options.accessToken}`);
  }

  if (options.requestSchema) {
    const parsed = options.requestSchema.safeParse(options.body);
    if (!parsed.success) {
      throw new ApiProtocolError("API request payload is invalid");
    }
    headers.set("content-type", "application/json");
    return { headers, body: JSON.stringify(parsed.data) };
  }

  return { headers, body: options.body as BodyInit | undefined };
}

async function throwResponseError(response: Response): Promise<never> {
  if (response.status === 401) {
    notifyApiAuthExpired();
    throw new ApiAuthError();
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiApplicationError("application_error", "Request failed", {
      status: response.status,
    });
  }

  const parsed = errorEnvelopeSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ApiApplicationError("application_error", "Request failed", {
      status: response.status,
    });
  }
  throw new ApiApplicationError(
    parsed.data.error.code,
    parsed.data.error.message,
    {
      ...(parsed.data.error.details
        ? { details: parsed.data.error.details }
        : {}),
      status: response.status,
    },
  );
}

function composeAbortSignal(
  callerSignal?: AbortSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
) {
  const controller = new AbortController();
  let abortSource: "caller" | "timeout" | undefined = callerSignal?.aborted
    ? "caller"
    : undefined;

  const handleCallerAbort = () => {
    abortSource ??= "caller";
    controller.abort(callerSignal?.reason);
  };

  if (callerSignal?.aborted) {
    controller.abort(callerSignal.reason);
  } else {
    callerSignal?.addEventListener("abort", handleCallerAbort, { once: true });
  }

  const timer = setTimeout(() => {
    if (!abortSource) {
      abortSource = "timeout";
      controller.abort();
    }
  }, timeoutMs);

  return {
    signal: controller.signal,
    didTimeout: () => abortSource === "timeout",
    wasCallerAbort: () => abortSource === "caller",
    cleanup: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", handleCallerAbort);
    },
  };
}
