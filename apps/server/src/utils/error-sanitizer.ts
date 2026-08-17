/**
 * Sanitize error messages before sending to the frontend.
 * Logs full error detail server-side, returns user-friendly message.
 */

const PROVIDER_PATTERN =
  /google|vertex|openai|replicate|langchain|gaxios|undici|fetch failed/i;
const DB_PATTERN =
  /supabase|postgres|pgmq|database|relation|column|constraint/i;
const AUTH_PATTERN =
  /jwt|token|unauthorized|forbidden|credential|service.account/i;
const INFRA_PATTERN =
  /econnrefused|econnreset|etimedout|dns|socket|tls|certificate/i;
const SENSITIVE_FIELD_PATTERN =
  /\b(password|token|secret|authorization|api[_-]?key|prompt|input|instruction|content|message(?:[_-]?content)?|payload|body|query)(\s*(?:[:=]|\bis\b)\s*)(?:"[^"]*"|'[^']*'|[^,;\r\n]+)/gi;
const BEARER_PATTERN = /\bbearer\s+[a-z0-9._~+/-]+=*/gi;

export type SanitizedErrorDiagnostic = {
  errorName: string;
  errorMessage: string;
  errorCode?: string;
  stackFingerprint?: string;
  errorCause?: SanitizedErrorDiagnostic;
};

/** Produces bounded diagnostics suitable for structured server logs. */
export function sanitizeErrorForLog(
  error: unknown,
  depth = 0,
): SanitizedErrorDiagnostic {
  const record = isRecord(error) ? error : undefined;
  const diagnostic: SanitizedErrorDiagnostic = {
    errorName: sanitizeDiagnosticText(
      error instanceof Error ? error.name : "UnknownError",
    ),
    errorMessage: sanitizeDiagnosticText(
      error instanceof Error ? error.message : String(error),
    ),
  };
  const code = record?.code;
  if (typeof code === "string") {
    diagnostic.errorCode = sanitizeDiagnosticText(code);
  }
  if (error instanceof Error && error.stack) {
    diagnostic.stackFingerprint = createHash("sha256")
      .update(error.stack)
      .digest("hex");
  }
  if (depth < 2 && record && "cause" in record && record.cause !== undefined) {
    diagnostic.errorCause = sanitizeErrorForLog(record.cause, depth + 1);
  }
  return diagnostic;
}

function sanitizeDiagnosticText(value: string, maxLength = 1_000): string {
  return value
    .replace(SENSITIVE_FIELD_PATTERN, "$1$2[REDACTED]")
    .replace(BEARER_PATTERN, "Bearer [REDACTED]")
    .slice(0, maxLength);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function sanitizeErrorForClient(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);

  // Log full detail server-side for debugging
  console.error("[error-sanitizer] Raw error:", raw);
  if (error instanceof Error) {
    // Log nested cause chain (LangChain wraps errors multiple levels deep)
    let cause: unknown = error.cause;
    while (cause) {
      console.error(
        "[error-sanitizer] Caused by:",
        isRecord(cause) && typeof cause.message === "string"
          ? cause.message
          : cause,
      );
      cause = isRecord(cause) ? cause.cause : undefined;
    }
    // Log response details if present (Google API errors attach response/details)
    const errorRecord = error as Error & Record<string, unknown>;
    const response = isRecord(errorRecord.response)
      ? errorRecord.response
      : undefined;
    if (response) {
      console.error("[error-sanitizer] Response status:", response.status);
      console.error(
        "[error-sanitizer] Response data:",
        JSON.stringify(response.data ?? response.body ?? "").substring(0, 2000),
      );
    }
    if (errorRecord.details) {
      console.error(
        "[error-sanitizer] Details:",
        JSON.stringify(errorRecord.details).substring(0, 2000),
      );
    }
    if (error.stack) {
      console.error("[error-sanitizer] Stack:", error.stack);
    }
  }

  // Map to user-friendly messages
  if (PROVIDER_PATTERN.test(raw)) {
    return "AI 服务暂时不可用，请稍后重试。";
  }
  if (DB_PATTERN.test(raw)) {
    return "数据服务异常，请稍后重试。";
  }
  if (AUTH_PATTERN.test(raw)) {
    return "认证失败，请刷新页面重新登录。";
  }
  if (INFRA_PATTERN.test(raw)) {
    return "网络连接异常，请检查网络后重试。";
  }
  if (raw.includes("abort") || raw.includes("cancel")) {
    return "请求已取消。";
  }
  if (raw.length > 100) {
    // Long messages are likely stack traces or JSON errors
    return "请求处理失败，请重试。";
  }

  // Short, non-technical messages can pass through
  return "请求处理失败，请重试。";
}
import { createHash } from "node:crypto";
