import {
  type BoundaryErrorCode,
  boundaryErrorCodeSchema,
} from "@loomic/shared";
import type { FastifyRequest } from "fastify";
import { z } from "zod";

import { AppError } from "../errors/app-error.js";
import { MarketplaceError } from "../features/skills/marketplace-service.js";
import { SkillImportError } from "../features/skills/skill-import-service.js";
export { parseRequest } from "../errors/request-validation.js";
import { parseRequest } from "../errors/request-validation.js";
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
  if (error instanceof SkillImportError) {
    return new AppError({
      code:
        error.code === "capability_disabled"
          ? "capability_disabled"
          : "skill_import_failed",
      statusCode: error.code === "capability_disabled" ? 403 : 400,
      message: error.message,
      expose: true,
      cause: error,
    });
  }
  if (error instanceof MarketplaceError) {
    const code =
      error.code === "search_failed"
        ? "marketplace_search_failed"
        : error.code === "package_not_found"
          ? "marketplace_detail_failed"
          : "marketplace_install_failed";
    return new AppError({
      code,
      statusCode: error.code === "package_not_found" ? 404 : 502,
      message: error.message,
      expose: true,
      cause: error,
    });
  }
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
