import { readFile, readdir } from "node:fs/promises";
import { extname, relative } from "node:path";

import { describe, expect, it } from "vitest";
import { envDescriptors } from "../../../../packages/config/src/env.js";

const agentRoot = new URL("./", import.meta.url);
const forbiddenConfigKeys = [
  "LOOMIC_ALLOW_LOCAL_AGENT_EXECUTE",
  "LOOMIC_AGENT_BACKEND_MODE",
  "LOOMIC_AGENT_FILES_ROOT",
  "LOOMIC_SKILLS_ROOT",
] as const;
const forbiddenSourcePatterns = [
  /\bLocalShellBackend\b/,
  /\bSandboxBackendProtocol\b/,
  /(?:from|import\s*)[\s\S]*?["'][^"']*\/backends(?:\/index)?\.js["']/,
  /["']node:child_process["']/,
  /\bname\s*:\s*["'](?:execute|persist_sandbox_file)["']/,
  /<canvas_state>/,
  /buildCanvasSummaryForContext\s*\(/,
] as const;

async function listProductionModules(directory: URL): Promise<URL[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const modules = await Promise.all(
    entries.map(async (entry) => {
      const entryUrl = new URL(entry.name, directory);
      if (entry.isDirectory()) {
        return listProductionModules(new URL(`${entry.name}/`, directory));
      }
      if (
        entry.isFile() &&
        extname(entry.name) === ".ts" &&
        !entry.name.endsWith(".test.ts")
      ) {
        return [entryUrl];
      }
      return [];
    }),
  );
  return modules.flat();
}

async function scanAgentAuthority(): Promise<string[]> {
  const violations: string[] = [];
  for (const moduleUrl of await listProductionModules(agentRoot)) {
    const source = await readFile(moduleUrl, "utf8");
    for (const pattern of forbiddenSourcePatterns) {
      if (pattern.test(source)) {
        violations.push(
          `${relative(agentRoot.pathname, moduleUrl.pathname)}: ${pattern.source}`,
        );
      }
    }
  }
  return violations.sort();
}

describe("Agent authority architecture", () => {
  it("removes every Agent process and generic backend authority", async () => {
    expect(await scanAgentAuthority()).toEqual([]);
    expect(envDescriptors.map((item) => item.key)).not.toEqual(
      expect.arrayContaining([...forbiddenConfigKeys]),
    );
  });
});
