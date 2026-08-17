import { z } from "zod";

import { AppError } from "../../errors/app-error.js";
import type { StructuredLogger } from "../generation/ports.js";

const importRequestSchema = z.object({
  url: z.url().refine(isSupportedSource, "Unsupported skill import source"),
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

export type SkillImportPrincipal = { userId: string; workspaceId: string };
export type ImportedSkillOutcome = z.infer<typeof importedSkillSchema>;

export type SkillImportPorts = {
  capability: { externalImportEnabled(): boolean };
  importer: { importFromUrl(url: string): Promise<unknown> };
};

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
      if (canonicalUrl(imported.sourceUrl) !== canonicalUrl(sourceUrl)) {
        throw new ImportOutcomeError("Imported skill source identity mismatch");
      }

      options.logger.info("Skill imported for review", {
        fileCount: imported.files.length,
        sourceHost,
        userId: principal.userId,
        workspaceId: principal.workspaceId,
      });
      return {
        imported,
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

function canonicalUrl(value: string): string {
  return new URL(value).href;
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
  return new AppError({
    code: "skill_import_failed",
    statusCode: 400,
    message: "Skill import failed.",
    expose: true,
    cause: error,
  });
}
