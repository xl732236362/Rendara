import { describe, expect, it, vi } from "vitest";

import { createSkillImportApplicationPort } from "./skill-import-application-adapter.js";

describe("skill import application adapter", () => {
  it("delegates unchanged URLs to the existing safe importer", async () => {
    const result = { sourceUrl: "https://github.com/acme/skill" };
    const importer = vi.fn(async () => result);
    const adapter = createSkillImportApplicationPort(importer as never);

    await expect(adapter.importFromUrl(result.sourceUrl)).resolves.toBe(result);
    expect(importer).toHaveBeenCalledWith(result.sourceUrl);
  });
});
