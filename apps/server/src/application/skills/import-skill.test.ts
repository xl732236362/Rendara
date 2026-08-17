import { describe, expect, it, vi } from "vitest";

import { SkillImportError } from "../../features/skills/skill-import-service.js";
import { SafeFetchError } from "../../security/safe-fetch.js";
import type { StructuredLogger } from "../generation/ports.js";
import { type SkillImportPorts, createImportSkill } from "./import-skill.js";

const principal = { userId: "user-1", workspaceId: "workspace-1" };
const sourceUrl = "https://github.com/acme/design-skill";

function imported(source = sourceUrl) {
  return {
    manifest: { name: "Design Skill", description: "Design assistance" },
    skillContent:
      "---\nname: Design Skill\ndescription: Design assistance\n---\n# Skill",
    files: [],
    sourceUrl: source,
  };
}

function setup(enabled = true) {
  const ports: SkillImportPorts = {
    capability: { externalImportEnabled: vi.fn(() => enabled) },
    importer: { importFromUrl: vi.fn(async () => imported()) },
  };
  const logger: StructuredLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return { importSkill: createImportSkill({ ports, logger }), logger, ports };
}

describe("ImportSkill", () => {
  it("gates the capability before validation and never calls the importer", async () => {
    const { importSkill, ports } = setup(false);

    await expect(
      importSkill(principal, { url: "not a URL" }),
    ).rejects.toMatchObject({ code: "capability_disabled", statusCode: 403 });

    expect(ports.importer.importFromUrl).not.toHaveBeenCalled();
  });

  it("rejects invalid or unsupported sources without calling the importer", async () => {
    const { importSkill, ports } = setup();

    await expect(
      importSkill(principal, { url: "https://evil.example/skill.tgz" }),
    ).rejects.toMatchObject({ code: "invalid_request", statusCode: 400 });

    expect(ports.importer.importFromUrl).not.toHaveBeenCalled();
  });

  it("rejects URL credentials before calling the importer", async () => {
    const { importSkill, ports } = setup();

    await expect(
      importSkill(principal, {
        url: "https://user:password@github.com/acme/design-skill",
      }),
    ).rejects.toMatchObject({ code: "invalid_request", statusCode: 400 });
    expect(ports.importer.importFromUrl).not.toHaveBeenCalled();
  });

  it("passes required query data but returns a canonical safe source URL", async () => {
    const secretUrl = `${sourceUrl}?token=super-secret#fragment`;
    const { importSkill, ports } = setup();
    vi.mocked(ports.importer.importFromUrl).mockResolvedValue(
      imported(secretUrl),
    );

    const result = await importSkill(principal, { url: secretUrl });

    expect(ports.importer.importFromUrl).toHaveBeenCalledWith(secretUrl);
    expect(result.imported.sourceUrl).toBe(sourceUrl);
    expect(JSON.stringify(result)).not.toContain("super-secret");
  });

  it.each([
    [
      "unsupported_source",
      "invalid_request",
      400,
      "Invalid skill import source.",
    ],
    ["manifest_parse_error", "invalid_request", 400, "Invalid skill manifest."],
    [
      "skill_archive_limit_exceeded",
      "invalid_request",
      400,
      "Skill archive exceeds import limits.",
    ],
    [
      "github_fetch_error",
      "upstream_error",
      502,
      "Skill source is unavailable.",
    ],
    [
      "tarball_extract_error",
      "upstream_error",
      502,
      "Skill source is unavailable.",
    ],
  ] as const)(
    "maps real %s failures to a fixed safe boundary",
    async (serviceCode, code, statusCode, message) => {
      const { importSkill, ports } = setup();
      vi.mocked(ports.importer.importFromUrl).mockRejectedValue(
        new SkillImportError(serviceCode, "private source details"),
      );

      await expect(
        importSkill(principal, { url: sourceUrl }),
      ).rejects.toMatchObject({ code, statusCode, message });
    },
  );

  it.each([
    ["upstream_error", "upstream_error", 502],
    ["request_timeout", "upstream_error", 502],
    ["unsafe_url", "invalid_request", 400],
    ["invalid_content_type", "invalid_request", 400],
    ["response_too_large", "invalid_request", 400],
  ] as const)(
    "maps safe-fetch %s without exposing its message",
    async (fetchCode, code, statusCode) => {
      const { importSkill, ports } = setup();
      vi.mocked(ports.importer.importFromUrl).mockRejectedValue(
        new SafeFetchError(fetchCode, "private network details"),
      );

      await expect(
        importSkill(principal, { url: sourceUrl }),
      ).rejects.toMatchObject({
        code,
        statusCode,
      });
    },
  );

  it("returns imported skills disabled and requiring review", async () => {
    const { importSkill } = setup();

    await expect(importSkill(principal, { url: sourceUrl })).resolves.toEqual({
      imported: imported(),
      requiresReview: true,
      enabled: false,
    });
  });

  it("privately rejects malformed or source-mismatched importer outcomes", async () => {
    const { importSkill, ports } = setup();
    vi.mocked(ports.importer.importFromUrl).mockResolvedValue(
      imported("https://github.com/acme/another-skill"),
    );

    await expect(
      importSkill(principal, { url: sourceUrl }),
    ).rejects.toMatchObject({
      code: "application_error",
      statusCode: 500,
      expose: false,
    });

    vi.mocked(ports.importer.importFromUrl).mockResolvedValue({
      files: [],
    } as never);
    await expect(
      importSkill(principal, { url: sourceUrl }),
    ).rejects.toMatchObject({
      code: "application_error",
      statusCode: 500,
      expose: false,
    });
  });

  it("normalizes importer failures and logs only safe source identity", async () => {
    const secretUrl = `${sourceUrl}?token=super-secret`;
    const { importSkill, logger, ports } = setup();
    vi.mocked(ports.importer.importFromUrl).mockRejectedValue(
      new Error("archive contained private contents"),
    );

    await expect(
      importSkill(principal, { url: secretUrl }),
    ).rejects.toMatchObject({
      code: "application_error",
      statusCode: 500,
      expose: false,
      message: "Skill import failed.",
    });
    const logs = JSON.stringify(vi.mocked(logger.error).mock.calls);
    expect(logs).toContain("github.com");
    expect(logs).not.toContain("super-secret");
    expect(logs).not.toContain("private contents");
  });
});
