import { describe, expect, it } from "vitest";

import { MemoryAgentExecutionRepository } from "../../features/agent-runs/agent-execution-repository.js";
import type { AgentExecutionContext } from "../execution-context.js";
import type { BuiltinSkillCatalog } from "./catalog.js";
import { readBuiltinSkill } from "./read-tool.js";

const encoder = new TextEncoder();

function context(
  overrides: Partial<AgentExecutionContext> = {},
): AgentExecutionContext {
  return {
    attemptId: "attempt-1",
    canvasId: "canvas-1",
    capabilities: ["skill.read", "image.generate"],
    capabilityPolicyVersion: "policy-1",
    effectiveSkillNames: ["json-image-prompt"],
    projectId: "project-1",
    runId: "run-1",
    skillCatalogDigest: "catalog-1",
    userId: "user-1",
    workspaceId: "workspace-1",
    ...overrides,
  };
}

function catalog(files: Record<string, string>): BuiltinSkillCatalog {
  return {
    digest: "catalog-1",
    list: () => [
      {
        name: "json-image-prompt",
        description: "Prompt guidance",
        requiredCapabilities: ["image.generate"],
      },
    ],
    get(name) {
      if (name !== "json-image-prompt") throw new Error("skill_not_found");
      return {
        name,
        description: "Prompt guidance",
        requiredCapabilities: ["image.generate"],
        files: Object.entries(files).map(([path, text]) => ({
          path,
          bytes: encoder.encode(text),
        })),
      };
    },
  };
}

describe("read_builtin_skill", () => {
  it("requires skill.read, effective membership and Skill prerequisites", async () => {
    const repository = new MemoryAgentExecutionRepository();
    const skills = catalog({ "SKILL.md": "instructions" });

    await expect(
      readBuiltinSkill({
        catalog: skills,
        context: context({ capabilities: ["image.generate"] }),
        repository,
        input: { skillName: "json-image-prompt", path: "SKILL.md" },
      }),
    ).rejects.toThrow("capability_denied");
    await expect(
      readBuiltinSkill({
        catalog: skills,
        context: context({ effectiveSkillNames: [] }),
        repository,
        input: { skillName: "json-image-prompt", path: "SKILL.md" },
      }),
    ).rejects.toThrow("skill_not_authorized");
  });

  it("rejects traversal and binary content", async () => {
    const repository = new MemoryAgentExecutionRepository();
    await expect(
      readBuiltinSkill({
        catalog: catalog({ "SKILL.md": "ok" }),
        context: context(),
        repository,
        input: { skillName: "json-image-prompt", path: "../SKILL.md" },
      }),
    ).rejects.toThrow("skill_path_invalid");
    const binary = catalog({ "SKILL.md": "ok" });
    const originalGet = binary.get;
    binary.get = ((name: string) => ({
      ...originalGet(name),
      files: [{ path: "data.bin", bytes: Uint8Array.from([0xff, 0xfe]) }],
    })) as never;
    await expect(
      readBuiltinSkill({
        catalog: binary,
        context: context(),
        repository,
        input: { skillName: "json-image-prompt", path: "data.bin" },
      }),
    ).rejects.toThrow("skill_file_not_text");
  });

  it("returns at most 32 KiB and binds opaque cursors to the run", async () => {
    const repository = new MemoryAgentExecutionRepository();
    const skills = catalog({ "SKILL.md": "a".repeat(40 * 1024) });
    const first = await readBuiltinSkill({
      catalog: skills,
      context: context(),
      repository,
      input: { skillName: "json-image-prompt", path: "SKILL.md" },
    });

    expect(Buffer.byteLength(first.text)).toBe(32 * 1024);
    expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await expect(
      readBuiltinSkill({
        catalog: skills,
        context: context({ runId: "run-other" }),
        repository,
        input: { skillName: "json-image-prompt", cursor: first.nextCursor },
      }),
    ).rejects.toThrow("skill_cursor_invalid");
    const second = await readBuiltinSkill({
      catalog: skills,
      context: context(),
      repository,
      input: { skillName: "json-image-prompt", cursor: first.nextCursor },
    });
    expect(Buffer.byteLength(second.text)).toBe(8 * 1024);
    expect(second.nextCursor).toBeUndefined();
  });

  it("makes retries idempotent and enforces shared distinct-read budget", async () => {
    const repository = new MemoryAgentExecutionRepository();
    const files = Object.fromEntries(
      Array.from({ length: 17 }, (_, index) => [
        `file-${index}.txt`,
        "x".repeat(100),
      ]),
    );
    const skills = catalog(files);
    const first = await readBuiltinSkill({
      catalog: skills,
      context: context(),
      repository,
      input: { skillName: "json-image-prompt", path: "file-0.txt" },
    });
    await expect(
      readBuiltinSkill({
        catalog: skills,
        context: context({ attemptId: "attempt-retry" }),
        repository,
        input: { skillName: "json-image-prompt", path: "file-0.txt" },
      }),
    ).resolves.toEqual(first);
    for (let index = 1; index < 16; index += 1) {
      await readBuiltinSkill({
        catalog: skills,
        context: context({ attemptId: `attempt-${index}` }),
        repository,
        input: {
          skillName: "json-image-prompt",
          path: `file-${index}.txt`,
        },
      });
    }
    await expect(
      readBuiltinSkill({
        catalog: skills,
        context: context(),
        repository,
        input: { skillName: "json-image-prompt", path: "file-16.txt" },
      }),
    ).rejects.toThrow("skill_read_budget_exceeded");
  });

  it("atomically prevents concurrent byte-budget overspend", async () => {
    const repository = new MemoryAgentExecutionRepository();
    const skills = catalog(
      Object.fromEntries(
        Array.from({ length: 9 }, (_, index) => [
          `large-${index}.txt`,
          "x".repeat(32 * 1024),
        ]),
      ),
    );
    const results = await Promise.allSettled(
      Array.from({ length: 9 }, (_, index) =>
        readBuiltinSkill({
          catalog: skills,
          context: context(),
          repository,
          input: {
            skillName: "json-image-prompt",
            path: `large-${index}.txt`,
          },
        }),
      ),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(8);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
  });
});
