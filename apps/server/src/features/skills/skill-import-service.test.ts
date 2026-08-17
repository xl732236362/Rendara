import { describe, expect, it } from "vitest";

import {
  SkillArchiveBudget,
  assertSkillImportEnabled,
  createImportedWorkspaceSkillRow,
  detectImportSource,
  importFromGitHub,
} from "./skill-import-service.js";

describe("external skill import capability", () => {
  it("rejects imports when the capability is disabled", () => {
    expect(() => assertSkillImportEnabled(false)).toThrowError(
      expect.objectContaining({ code: "capability_disabled" }),
    );
  });

  it("accepts imports only when explicitly enabled", () => {
    expect(() => assertSkillImportEnabled(true)).not.toThrow();
  });

  it("does not classify arbitrary tarball hosts as npm sources", () => {
    expect(detectImportSource("https://evil.example/skill.tgz")).toBe(
      "unknown",
    );
    expect(
      detectImportSource("https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz"),
    ).toBe("npm-tarball");
  });

  it("installs imported skills disabled pending review", () => {
    expect(
      createImportedWorkspaceSkillRow("workspace-1", "skill-1", "user-1"),
    ).toEqual({
      enabled: false,
      installed_by: "user-1",
      skill_id: "skill-1",
      workspace_id: "workspace-1",
    });
  });
});

describe("SkillArchiveBudget", () => {
  it("rejects archives larger than 10 MB before extraction", () => {
    expect(() =>
      SkillArchiveBudget.forArchive(10 * 1024 * 1024 + 1),
    ).toThrowError(
      expect.objectContaining({ code: "skill_archive_limit_exceeded" }),
    );
  });

  it("rejects too many entries", () => {
    const budget = SkillArchiveBudget.forArchive(1);
    for (let index = 0; index < 200; index += 1) {
      budget.accept(`scripts/file-${index}.txt`, 1);
    }

    expect(() => budget.accept("scripts/overflow.txt", 1)).toThrowError(
      expect.objectContaining({ code: "skill_archive_limit_exceeded" }),
    );
  });

  it("rejects oversized files, deep paths, and excessive expanded text", () => {
    expect(() =>
      SkillArchiveBudget.forArchive(1).accept(
        "scripts/large.txt",
        1024 * 1024 + 1,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "skill_archive_limit_exceeded" }),
    );

    expect(() =>
      SkillArchiveBudget.forArchive(1).accept("a/b/c/d/e/f/g/h/i/file.txt", 1),
    ).toThrowError(
      expect.objectContaining({ code: "skill_archive_limit_exceeded" }),
    );

    const budget = SkillArchiveBudget.forArchive(1);
    for (let index = 0; index < 20; index += 1) {
      budget.accept(`references/file-${index}.txt`, 1024 * 1024);
    }
    expect(() => budget.accept("references/overflow.txt", 1)).toThrowError(
      expect.objectContaining({ code: "skill_archive_limit_exceeded" }),
    );
  });

  it("rejects archive paths that could escape the skill directory", () => {
    expect(() =>
      SkillArchiveBudget.forArchive(1).accept("scripts/../../outside.sh", 1),
    ).toThrowError(
      expect.objectContaining({ code: "skill_archive_limit_exceeded" }),
    );
  });

  it("counts actual GitHub download bytes instead of trusting API sizes", async () => {
    const rootItems = [
      {
        name: "SKILL.md",
        path: "SKILL.md",
        type: "file",
        size: 1,
        download_url:
          "https://raw.githubusercontent.com/acme/demo/main/SKILL.md",
      },
      {
        name: "references",
        path: "references",
        type: "dir",
        size: 0,
        download_url: null,
      },
    ];
    const referenceItems = Array.from({ length: 21 }, (_, index) => ({
      name: `file-${index}.txt`,
      path: `references/file-${index}.txt`,
      type: "file",
      size: 1,
      download_url: `https://raw.githubusercontent.com/acme/demo/main/references/file-${index}.txt`,
    }));

    await expect(
      importFromGitHub("https://github.com/acme/demo", {
        safeFetch: async (input) => {
          const url = new URL(input);
          let body: Buffer;
          if (url.hostname === "api.github.com") {
            body = Buffer.from(
              JSON.stringify(
                url.pathname.endsWith("/references")
                  ? referenceItems
                  : rootItems,
              ),
            );
          } else if (url.pathname.endsWith("/SKILL.md")) {
            body = Buffer.from(
              "---\nname: demo\ndescription: Demo skill\n---\n# Demo",
            );
          } else {
            body = Buffer.alloc(1024 * 1024, "a");
          }
          return {
            body,
            contentType: "application/octet-stream",
            finalUrl: url,
          };
        },
      }),
    ).rejects.toMatchObject({ code: "skill_archive_limit_exceeded" });
  });
});

describe("skill importer logging", () => {
  it("keeps malicious remote identifiers bounded and single-line", async () => {
    const longSecret = `secret-${"x".repeat(300)}`;
    const logs: string[] = [];
    const warnings: string[] = [];
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.log = (...values: unknown[]) => logs.push(values.join(" "));
    console.warn = (...values: unknown[]) => warnings.push(values.join(" "));
    try {
      await importFromGitHub("https://github.com/acme/demo", {
        safeFetch: async (input) => {
          const url = new URL(input);
          if (url.hostname === "api.github.com") {
            const isReferences = url.pathname.endsWith("/references");
            return {
              body: Buffer.from(
                JSON.stringify(
                  isReferences
                    ? [
                        {
                          name: `image\r\n[skill-import] forged ${longSecret}.png`,
                          path: `references/image\r\n${longSecret}.png`,
                          type: "file",
                          size: 1,
                          download_url: null,
                        },
                        {
                          name: `missing\n[ERROR] ${longSecret}.txt`,
                          path: `references/missing\n${longSecret}.txt`,
                          type: "file",
                          size: 1,
                          download_url: null,
                        },
                      ]
                    : [
                        {
                          name: "SKILL.md",
                          path: "SKILL.md",
                          type: "file",
                          size: 1,
                          download_url:
                            "https://raw.githubusercontent.com/acme/demo/main/SKILL.md",
                        },
                        {
                          name: "references",
                          path: "references",
                          type: "dir",
                          size: 0,
                          download_url: null,
                        },
                      ],
                ),
              ),
              contentType: "application/json",
              finalUrl: url,
            };
          }
          return {
            body: Buffer.from(
              `---\nname: |\n  forged\n  [skill-import] ${longSecret}\ndescription: malicious\nversion: |\n  1.0\n  ${longSecret}\n---\n# Demo`,
            ),
            contentType: "text/markdown",
            finalUrl: url,
          };
        },
      });
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
    }

    const records = [...logs, ...warnings];
    expect(records.length).toBeGreaterThan(0);
    expect(
      records.some((record) => record.includes("event=github_import_complete")),
    ).toBe(true);
    expect(
      records.some((record) =>
        record.includes("source=https://api.github.com"),
      ),
    ).toBe(true);
    expect(
      records.every((record) => Array.from(record).every(isPrintable)),
    ).toBe(true);
    expect(records.every((record) => record.length <= 240)).toBe(true);
    expect(records.join("\n")).not.toContain(longSecret);
    expect(records.join("\n")).not.toContain("[ERROR]");
  });
});

function isPrintable(character: string): boolean {
  const code = character.charCodeAt(0);
  return code >= 32 && (code < 127 || code > 159);
}
