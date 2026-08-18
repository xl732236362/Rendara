import {
  type BoundaryErrorCode,
  boundaryErrorCodeSchema,
} from "@loomic/shared";
import type { FastifyRequest } from "fastify";
import { z } from "zod";

import { AppError } from "../errors/app-error.js";
export { parseRequest } from "../errors/request-validation.js";
import { parseRequest } from "../errors/request-validation.js";
import type {
  AuthenticatedUser,
  RequestAuthenticator,
} from "../supabase/user.js";
import { safeRead } from "../utils/safe-error-inspection.js";

const LEGACY_PUBLIC_ERRORS: Partial<
  Record<BoundaryErrorCode, { statusCode: number; message: string }>
> = {
  unauthorized: { statusCode: 401, message: "Authentication required." },
  invalid_request: { statusCode: 400, message: "Request validation failed." },
  forbidden: { statusCode: 403, message: "Access denied." },
  capability_disabled: {
    statusCode: 403,
    message: "This capability is disabled.",
  },
  insufficient_credits: { statusCode: 402, message: "Insufficient credits." },
  project_not_found: { statusCode: 404, message: "Project not found." },
  project_slug_taken: {
    statusCode: 409,
    message: "Project name is already in use.",
  },
  canvas_not_found: { statusCode: 404, message: "Canvas not found." },
  session_not_found: { statusCode: 404, message: "Session not found." },
  job_not_found: { statusCode: 404, message: "Job not found." },
  job_create_failed: { statusCode: 500, message: "Job creation failed." },
  job_query_failed: { statusCode: 500, message: "Job query failed." },
  asset_not_found: { statusCode: 404, message: "Asset not found." },
  settings_not_found: { statusCode: 404, message: "Settings not found." },
  brand_kit_not_found: { statusCode: 404, message: "Brand kit not found." },
  brand_kit_asset_not_found: {
    statusCode: 404,
    message: "Brand kit asset not found.",
  },
  skill_not_found: { statusCode: 404, message: "Skill not found." },
  variant_not_found: { statusCode: 404, message: "Payment variant not found." },
  subscription_not_found: {
    statusCode: 404,
    message: "Subscription not found.",
  },
  model_not_accessible: {
    statusCode: 403,
    message: "Model is not accessible.",
  },
  resolution_not_allowed: {
    statusCode: 403,
    message: "Resolution is not allowed.",
  },
  concurrency_limit: { statusCode: 429, message: "Concurrency limit reached." },
  rate_limited: { statusCode: 429, message: "Too many requests." },
  skill_import_failed: { statusCode: 400, message: "Skill import failed." },
  marketplace_detail_failed: {
    statusCode: 404,
    message: "Marketplace item not found.",
  },
  marketplace_search_failed: {
    statusCode: 502,
    message: "Marketplace search failed.",
  },
  marketplace_install_failed: {
    statusCode: 502,
    message: "Marketplace install failed.",
  },
};

export async function authenticateOrThrow(
  auth: RequestAuthenticator,
  request: Pick<FastifyRequest, "headers">,
): Promise<AuthenticatedUser> {
  const user = await auth.authenticate(request);
  if (!user) {
    throw new AppError({
      code: "unauthorized",
      statusCode: 401,
      message: "Missing or invalid bearer token.",
      expose: true,
    });
  }
  return user;
}

/** Converts only the stable legacy service-error shape into an AppError. */
export function normalizeLegacyServiceError(error: unknown): AppError | null {
  if (!(error instanceof Error)) return null;
  const statusCode = safeRead(error, "statusCode");
  const parsedCode = boundaryErrorCodeSchema.safeParse(safeRead(error, "code"));
  if (
    !Number.isInteger(statusCode) ||
    (statusCode as number) < 400 ||
    (statusCode as number) > 599 ||
    !parsedCode.success
  ) {
    return null;
  }
  return legacyAppError(parsedCode.data, statusCode as number, error);
}

function legacyAppError(
  code: BoundaryErrorCode,
  statusCode: number,
  cause: Error,
): AppError {
  const publicError = LEGACY_PUBLIC_ERRORS[code];
  if (!publicError || publicError.statusCode !== statusCode) {
    return new AppError({
      code: "application_error",
      statusCode: 500,
      message: "An unexpected error occurred",
      cause,
    });
  }
  return new AppError({
    code,
    statusCode,
    message: publicError.message,
    expose: true,
    cause,
  });
}

export function throwLegacyServiceError(error: unknown): never {
  throw normalizeLegacyServiceError(error) ?? error;
}

export function throwRouteError(options: {
  code: BoundaryErrorCode;
  statusCode: number;
  message: string;
}): never {
  throw new AppError({ ...options, expose: true });
}

export function parseStringParams<const Key extends string>(
  input: unknown,
  keys: readonly Key[],
): Record<Key, string> {
  const shape = Object.fromEntries(keys.map((key) => [key, z.string().min(1)]));
  return parseRequest(z.object(shape), input) as Record<Key, string>;
}

export function raiseBoundaryError(
  payload: unknown,
  statusCode: number,
): never {
  const error = safeRead(payload, "error");
  const parsedCode = boundaryErrorCodeSchema.safeParse(safeRead(error, "code"));
  const message = safeRead(error, "message");
  if (!parsedCode.success || typeof message !== "string" || !message.trim()) {
    throw new Error("Invalid route error payload");
  }
  throwRouteError({
    code: parsedCode.data,
    statusCode,
    message,
  });
}
