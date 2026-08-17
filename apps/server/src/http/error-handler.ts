import { errorEnvelopeSchema } from "@loomic/shared";
import type { FastifyError, FastifyInstance, FastifyRequest } from "fastify";

import {
  AppError,
  type AppErrorCode,
  type SafeErrorDetails,
} from "../errors/app-error.js";
import { RequestValidationError } from "../errors/request-validation.js";
import { sanitizeErrorForLog } from "../utils/error-sanitizer.js";
import {
  safeInstanceOf,
  safeRead,
  safeReadString,
} from "../utils/safe-error-inspection.js";

const ABORT_CODES = new Set([
  "ABORT_ERR",
  "ECONNRESET",
  "ERR_STREAM_PREMATURE_CLOSE",
]);
const FALLBACK_ENVELOPE = {
  error: {
    code: "application_error",
    message: "An unexpected error occurred",
  },
} as const;

type ClassifiedError = {
  code: AppErrorCode;
  statusCode: number;
  message: string;
  details?: SafeErrorDetails;
  interrupted: boolean;
};

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    let classified: ClassifiedError;
    try {
      classified = classifyError(error, request);
      logFailure(request, error, classified);
    } catch {
      classified = internalError();
      logFallbackFailure(request);
    }

    if (reply.sent) {
      return reply;
    }

    const parsedEnvelope = errorEnvelopeSchema.safeParse({
      error: {
        code: classified.code,
        message: classified.message,
        ...(classified.details ? { details: classified.details } : {}),
      },
    });
    const envelope = parsedEnvelope.success
      ? parsedEnvelope.data
      : FALLBACK_ENVELOPE;

    return reply
      .code(parsedEnvelope.success ? classified.statusCode : 500)
      .send(envelope);
  });
}

function classifyError(
  error: unknown,
  request: FastifyRequest,
): ClassifiedError {
  if (safeInstanceOf(error, RequestValidationError)) {
    return invalidRequest((error as RequestValidationError).issues);
  }

  const validation = safeRead(error, "validation") as
    | FastifyError["validation"]
    | undefined;
  if (Array.isArray(validation)) {
    return invalidRequest(
      validation.map((issue) => ({
        code: issue.keyword,
        message: issue.message ?? "Invalid value",
        path: issue.instancePath
          ? issue.instancePath.split("/").filter(Boolean)
          : [],
      })),
    );
  }

  if (safeInstanceOf(error, AppError)) {
    const appError = error as AppError;
    return {
      code: appError.code,
      statusCode: appError.statusCode,
      message: appError.expose
        ? appError.message
        : "An unexpected error occurred",
      ...(appError.expose && appError.details
        ? { details: appError.details }
        : {}),
      interrupted: false,
    };
  }

  if (safeRead(error, "statusCode") === 400) {
    return {
      code: "invalid_request",
      statusCode: 400,
      message: "Request validation failed",
      interrupted: false,
    };
  }

  const nativeCode = getErrorCode(error);
  if (
    (request.raw.aborted || request.raw.destroyed) &&
    (ABORT_CODES.has(nativeCode) || getErrorName(error) === "AbortError")
  ) {
    return {
      code: "request_aborted",
      statusCode: 499,
      message: "Request was aborted",
      interrupted: true,
    };
  }
  return internalError();
}

function internalError(): ClassifiedError {
  return {
    code: "application_error",
    statusCode: 500,
    message: "An unexpected error occurred",
    interrupted: false,
  };
}

function invalidRequest(issues: unknown[]): ClassifiedError {
  return {
    code: "invalid_request",
    statusCode: 400,
    message: "Request validation failed",
    details: { issues },
    interrupted: false,
  };
}

function getErrorCode(error: unknown): string {
  return safeReadString(error, "code") ?? "";
}

function getErrorName(error: unknown): string {
  return safeReadString(error, "name") ?? "UnknownError";
}

function logFallbackFailure(request: FastifyRequest): void {
  try {
    request.log.error(
      {
        event: "http_request_failed",
        requestId: request.id,
        method: request.method,
        route: request.routeOptions.url,
        statusCode: 500,
        boundaryCode: "application_error",
        errorName: "UninspectableError",
      },
      "HTTP request failed",
    );
  } catch {
    // Logging must never prevent the canonical fallback response.
  }
}

function logFailure(
  request: FastifyRequest,
  error: unknown,
  classified: ClassifiedError,
): void {
  const fields = {
    event: classified.interrupted
      ? "http_request_interrupted"
      : "http_request_failed",
    requestId: request.id,
    method: request.method,
    route: request.routeOptions.url,
    statusCode: classified.statusCode,
    boundaryCode: classified.code,
    ...sanitizeErrorForLog(error),
  };

  if (classified.interrupted) {
    request.log.info(fields, "HTTP request interrupted");
    return;
  }

  if (classified.statusCode >= 500) {
    request.log.error(fields, "HTTP request failed");
    return;
  }

  request.log.warn(fields, "HTTP request rejected");
}
