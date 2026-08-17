import { errorEnvelopeSchema } from "@loomic/shared";
import type { FastifyError, FastifyInstance, FastifyRequest } from "fastify";

import {
  AppError,
  type AppErrorCode,
  type SafeErrorDetails,
} from "../errors/app-error.js";
import { RequestValidationError } from "../errors/request-validation.js";
import { sanitizeErrorForLog } from "../utils/error-sanitizer.js";

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
    const classified = classifyError(error, request);
    logFailure(request, error, classified);

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
  if (error instanceof RequestValidationError) {
    return invalidRequest(error.issues);
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
