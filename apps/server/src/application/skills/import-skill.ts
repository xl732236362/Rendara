import { z } from "zod";

import { AppError } from "../../errors/app-error.js";
import type { StructuredLogger } from "../generation/ports.js";

const importRequestSchema = z.object({
  url: z
    .url()
    .refine(hasNoCredentials, "URL credentials are not allowed")
    .refine(isSupportedSource, "Unsupported skill import source"),
});

const importedSkillSchema = z.object({
  manifest: z
    .object({
      name: z.string().min(1),
      description: z.string().min(1),
      license: z.string().optional(),
      version: z.string().optional(),
      author: z.string().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    })
    .passthrough(),
  skillContent: z.string().min(1),
  files: z.array(
    z.object({
      filePath: z.string().min(1),
      content: z.string(),
      mimeType: z.string().min(1),
    }),
  ),
  sourceUrl: z.url(),
});

export type SkillImportPrincipal = { userId: string; workspaceId?: string };
export type ImportedSkillOutcome = z.infer<typeof importedSkillSchema>;

export type SkillImportPorts = {
  capability: { externalImportEnabled(): boolean };
  importer: { importFromUrl(url: string): Promise<unknown> };
};

export type ImportSkill = ReturnType<typeof createImportSkill>;

export function createImportSkill(options: {
  ports: SkillImportPorts;
  logger: StructuredLogger;
}) {
  return async (principal: SkillImportPrincipal, rawRequest: unknown) => {
    if (!options.ports.capability.externalImportEnabled()) {
      throw new AppError({
        code: "capability_disabled",
        statusCode: 403,
        message: "External skill import is disabled.",
        expose: true,
      });
    }

    const parsed = importRequestSchema.safeParse(rawRequest);
    if (!parsed.success) {
      throw new AppError({
        code: "invalid_request",
        statusCode: 400,
        message: "Invalid skill import request.",
        expose: true,
        details: { issues: parsed.error.issues },
      });
    }

    const sourceUrl = parsed.data.url;
    const sourceHost = new URL(sourceUrl).hostname;
    try {
      const imported = importedSkillSchema.parse(
        await options.ports.importer.importFromUrl(sourceUrl),
      );
      const canonicalSourceUrl = canonicalUrl(sourceUrl);
      if (canonicalUrl(imported.sourceUrl) !== canonicalSourceUrl) {
        throw new ImportOutcomeError("Imported skill source identity mismatch");
      }

      options.logger.info("Skill imported for review", {
        fileCount: imported.files.length,
        sourceHost,
        userId: principal.userId,
        workspaceId: principal.workspaceId,
      });
      return {
        imported: { ...imported, sourceUrl: canonicalSourceUrl },
        requiresReview: true as const,
        enabled: false as const,
      };
    } catch (error) {
      const normalized = normalizeSkillImportError(error);
      options.logger.error("Skill import failed", {
        errorCode: normalized.code,
        sourceHost,
        userId: principal.userId,
        workspaceId: principal.workspaceId,
      });
      throw normalized;
    }
  };
}

function isSupportedSource(value: string): boolean {
  const url = new URL(value);
  if (url.protocol !== "https:") return false;
  if (url.hostname === "github.com") return url.pathname.split("/").length >= 3;
  return (
    url.hostname === "registry.npmjs.org" &&
    (url.pathname.endsWith(".tgz") || url.pathname.endsWith(".tar.gz"))
  );
}

function hasNoCredentials(value: string): boolean {
  const url = new URL(value);
  return url.username.length === 0 && url.password.length === 0;
}

function canonicalUrl(value: string): string {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.href;
}

class ImportOutcomeError extends Error {}

function normalizeSkillImportError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof z.ZodError || error instanceof ImportOutcomeError) {
    return new AppError({
      code: "application_error",
      statusCode: 500,
      message: "Skill importer returned an invalid result.",
      cause: error,
    });
  }
  const serviceCode = readServiceCode(error);
  const clientFailure = clientSkillFailure(serviceCode);
  if (clientFailure) {
    return new AppError({
      code: clientFailure.code,
      statusCode: clientFailure.statusCode,
      message: clientFailure.message,
      expose: true,
      cause: error,
    });
  }
  return new AppError({
    code: "application_error",
    statusCode: 500,
    message: "Skill import failed.",
    cause: error,
  });
}

function readServiceCode(error: unknown): string | undefined {
  return error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

function clientSkillFailure(code: string | undefined): {
  code: "invalid_request" | "capability_disabled" | "upstream_error";
  statusCode: 400 | 403 | 502;
  message: string;
} | null {
  switch (code) {
    case "capability_disabled":
      return {
        code,
        statusCode: 403,
        message: "External skill import is disabled.",
      };
    case "unsupported_source":
      return {
        code: "invalid_request",
        statusCode: 400,
        message: "Invalid skill import source.",
      };
    case "manifest_not_found":
    case "manifest_parse_error":
    case "manifest_validation_error":
      return {
        code: "invalid_request",
        statusCode: 400,
        message: "Invalid skill manifest.",
      };
    case "skill_archive_limit_exceeded":
      return {
        code: "invalid_request",
        statusCode: 400,
        message: "Skill archive exceeds import limits.",
      };
    case "github_fetch_error":
    case "tarball_extract_error":
    case "upstream_error":
    case "request_timeout":
      return {
        code: "upstream_error",
        statusCode: 502,
        message: "Skill source is unavailable.",
      };
    case "unsafe_url":
    case "invalid_content_type":
    case "response_too_large":
      return {
        code: "invalid_request",
        statusCode: 400,
        message: "Invalid skill import source.",
      };
    default:
      return null;
  }
}
