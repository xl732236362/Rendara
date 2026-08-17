import {
  type BoundaryErrorCode,
  boundaryErrorCodeSchema,
} from "@loomic/shared";
import type { FastifyRequest } from "fastify";

import { AppError } from "../errors/app-error.js";
export { parseRequest } from "../errors/request-validation.js";
import type {
  AuthenticatedUser,
  RequestAuthenticator,
} from "../supabase/user.js";
import { safeRead } from "../utils/safe-error-inspection.js";

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
  return new AppError({
    code: parsedCode.data as BoundaryErrorCode,
    statusCode: statusCode as number,
    message: error.message,
    expose: true,
    cause: error,
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

export function raiseBoundaryError(
  payload: unknown,
  statusCode?: number,
): never {
  const error = safeRead(payload, "error");
  const parsedCode = boundaryErrorCodeSchema.safeParse(safeRead(error, "code"));
  const message = safeRead(error, "message");
  if (!parsedCode.success || typeof message !== "string" || !message.trim()) {
    throw new Error("Invalid route error payload");
  }
  throwRouteError({
    code: parsedCode.data,
    statusCode: statusCode ?? inferStatusCode(parsedCode.data),
    message,
  });
}

function inferStatusCode(code: BoundaryErrorCode): number {
  if (code === "unauthorized") return 401;
  if (code === "forbidden" || code === "unsafe_url") return 403;
  if (code === "invalid_request") return 400;
  if (code === "insufficient_credits") return 402;
  if (code === "capability_disabled") return 403;
  if (code.endsWith("_not_found")) return 404;
  if (code.endsWith("_slug_taken")) return 409;
  if (code === "rate_limited" || code === "concurrency_limit") return 429;
  if (code === "response_too_large") return 413;
  if (code === "invalid_content_type") return 415;
  if (code === "upstream_error") return 502;
  return 500;
}
