import { errorEnvelopeSchema } from "@loomic/shared";
import type { FastifyError, FastifyInstance, FastifyRequest } from "fastify";
import { ZodError, type ZodIssue } from "zod";

import {
  AppError,
  type AppErrorCode,
  type SafeErrorDetails,
} from "../errors/app-error.js";

const ABORT_CODES = new Set([
  "ABORT_ERR",
  "ECONNRESET",
  "ERR_STREAM_PREMATURE_CLOSE",
]);
const TIMEOUT_CODES = new Set([
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

type ClassifiedError = {
  code: AppErrorCode;
  statusCode: number;
  message: string;
  details?: SafeErrorDetails;
  interrupted: boolean;
};

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const classified = classifyError(error);
    logFailure(request, error, classified);

    const envelope = errorEnvelopeSchema.parse({
      error: {
        code: classified.code,
        message: classified.message,
        ...(classified.details ? { details: classified.details } : {}),
      },
    });

    return reply.code(classified.statusCode).send(envelope);
  });
}

function classifyError(error: unknown): ClassifiedError {
  if (error instanceof ZodError) {
    return invalidRequest(error.issues.map(toSafeZodIssue));
  }

  const validation = (error as FastifyError | null)?.validation;
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

  if (error instanceof AppError) {
    return {
      code: error.code,
      statusCode: error.statusCode,
      message: error.expose ? error.message : "An unexpected error occurred",
      ...(error.expose && error.details ? { details: error.details } : {}),
      interrupted: false,
    };
  }

  if ((error as FastifyError | null)?.statusCode === 400) {
    return {
      code: "invalid_request",
      statusCode: 400,
      message: "Request validation failed",
      interrupted: false,
    };
  }

  const nativeCode = getErrorCode(error);
  if (ABORT_CODES.has(nativeCode) || getErrorName(error) === "AbortError") {
    return {
      code: "request_aborted",
      statusCode: 499,
      message: "Request was aborted",
      interrupted: true,
    };
  }
  if (TIMEOUT_CODES.has(nativeCode) || getErrorName(error) === "TimeoutError") {
    return {
      code: "request_timeout",
      statusCode: 504,
      message: "Request timed out",
      interrupted: true,
    };
  }

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

function toSafeZodIssue(issue: ZodIssue): Record<string, unknown> {
  return {
    code: issue.code,
    message: issue.message,
    path: issue.path,
  };
}

function getErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "";
}

function getErrorName(error: unknown): string {
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === "string" ? name : "UnknownError";
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
    errorCode: classified.code,
    errorName: getErrorName(error),
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
