import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const migratedAdapters = [
  "../http/jobs.ts",
  "../http/generate.ts",
  "../agent/runtime.ts",
];

describe("application entrypoint boundaries", () => {
  it.each(migratedAdapters)(
    "keeps generation orchestration out of %s",
    async (path) => {
      const source = await readFile(new URL(path, import.meta.url), "utf8");
      expect(source).not.toMatch(
        /\.(?:createJob|cancelJob|setCreditsInfo)\s*\(/,
      );
      const queuedSource =
        path === "../http/generate.ts"
          ? source.slice(source.indexOf('app.post("/api/agent/generate-video"'))
          : source;
      // The synchronous image endpoint remains a Task 6 direct-generation path.
      expect(queuedSource).not.toMatch(
        /(?:tierGuard|creditService)\.(?:check|calculate|deduct)/,
      );
    },
  );

  it("keeps canvas persistence behind ApplyCanvasOperations", async () => {
    const source = await readFile(
      new URL("../agent/tools/manipulate-canvas.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/\.from\(["']canvases["']\)/);
  });
});
