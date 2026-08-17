import { describe, expect, it, vi } from "vitest";

import { createSkillImportApplicationPort } from "./skill-import-application-adapter.js";
import { importSkillFromUrl } from "./skill-import-service.js";

describe("skill import application adapter", () => {
  it("delegates unchanged URLs to the existing safe importer", async () => {
    const result = { sourceUrl: "https://github.com/acme/skill" };
    const importer = vi.fn(async () => result);
    const adapter = createSkillImportApplicationPort(importer as never);

    await expect(adapter.importFromUrl(result.sourceUrl)).resolves.toBe(result);
    expect(importer).toHaveBeenCalledWith(result.sourceUrl);
  });

  it("safe importer source paths never log URL credentials, query, or hash", async () => {
    const logs: string[] = [];
    const log = console.log;
    console.log = (...values: unknown[]) => logs.push(values.join(" "));
    try {
      for (const secretUrl of [
        "https://user:password@github.com/acme/skill?token=query-secret#hash-secret",
        "https://user:password@registry.npmjs.org/pkg/-/pkg.tgz?token=query-secret#hash-secret",
      ]) {
        await importSkillFromUrl(secretUrl, {
          safeFetch: async () => {
            throw new Error("stop after logging");
          },
        }).catch(() => undefined);
      }
    } finally {
      console.log = log;
    }

    const output = logs.join("\n");
    expect(output).toContain("https://github.com");
    expect(output).toContain("https://registry.npmjs.org");
    expect(output).not.toContain("user");
    expect(output).not.toContain("password");
    expect(output).not.toContain("query-secret");
    expect(output).not.toContain("hash-secret");
  });

  it("default adapter path sanitizes secret-bearing unsupported sources", async () => {
    const logs: string[] = [];
    const log = console.log;
    console.log = (...values: unknown[]) => logs.push(values.join(" "));
    const adapter = createSkillImportApplicationPort();
    try {
      await adapter
        .importFromUrl(
          "https://user:password@evil.example/skill.zip?token=query-secret#hash-secret",
        )
        .catch(() => undefined);
    } finally {
      console.log = log;
    }

    const output = logs.join("\n");
    expect(output).toContain("https://evil.example");
    expect(output).not.toContain("user");
    expect(output).not.toContain("password");
    expect(output).not.toContain("query-secret");
    expect(output).not.toContain("hash-secret");
  });
});
