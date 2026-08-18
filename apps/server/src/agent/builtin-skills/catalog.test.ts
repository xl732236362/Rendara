import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  type BuiltinSkillCatalog,
  loadBuiltinSkillCatalog,
} from "./catalog.js";

const temporaryRoots: string[] = [];
const validSkill = `---
name: alpha-skill
description: A bounded built-in test Skill.
license: Apache-2.0
metadata:
  author: loomic
  version: "1.0"
---

# Alpha

Use the authorized image tool.
`;

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("built-in Skill catalog", () => {
  it("loads only the manifest-listed Skill and excludes canvas-design", async () => {
    const catalog = await loadRepositoryCatalog();

    expect(catalog.list()).toEqual([
      expect.objectContaining({
        name: "json-image-prompt",
        requiredCapabilities: ["image.generate"],
      }),
    ]);
    expect(() => catalog.get("canvas-design")).toThrow("skill_not_found");
  });

  it.each([
    ["unknown root field", { extra: true }],
    ["unknown schema version", { schemaVersion: 2 }],
  ])("rejects a closed manifest with %s", async (_name, override) => {
    const fixture = await createFixture();
    await fixture.writeManifest({ ...fixture.manifest, ...override });

    await expect(loadFixture(fixture)).rejects.toThrow("skill_catalog_invalid");
  });

  it("rejects unknown capabilities and duplicate names or paths", async () => {
    const unknownCapability = await createFixture();
    await unknownCapability.writeManifest({
      schemaVersion: 1,
      skills: [
        {
          name: "alpha-skill",
          path: "alpha-skill",
          requiredCapabilities: ["shell.execute"],
        },
      ],
    });
    await expect(loadFixture(unknownCapability)).rejects.toThrow(
      "skill_catalog_invalid",
    );

    for (const duplicateField of ["name", "path"] as const) {
      const duplicate = await createFixture();
      await duplicate.addSkill(
        "beta-skill",
        validSkill.replaceAll("alpha", "beta"),
      );
      const second = {
        name: "beta-skill",
        path: "beta-skill",
        requiredCapabilities: ["image.generate"],
      };
      second[duplicateField] = "alpha-skill";
      await duplicate.writeManifest({
        schemaVersion: 1,
        skills: [duplicate.manifest.skills[0], second],
      });
      await expect(loadFixture(duplicate)).rejects.toThrow(
        "skill_catalog_invalid",
      );
    }
  });

  it("rejects identity mismatch, malformed frontmatter, and long descriptions", async () => {
    for (const content of [
      validSkill.replace("name: alpha-skill", "name: another-skill"),
      "# Missing frontmatter",
      validSkill.replace("A bounded built-in test Skill.", "x".repeat(1_025)),
    ]) {
      const fixture = await createFixture({ content });
      await expect(loadFixture(fixture)).rejects.toThrow(
        "skill_catalog_invalid",
      );
    }
  });

  it.each(["../outside", "/absolute", "alpha-skill/../outside"])(
    "rejects traversal or absolute manifest path %s",
    async (path) => {
      const fixture = await createFixture();
      await fixture.writeManifest({
        schemaVersion: 1,
        skills: [
          {
            name: "alpha-skill",
            path,
            requiredCapabilities: ["image.generate"],
          },
        ],
      });

      await expect(loadFixture(fixture)).rejects.toThrow(
        "skill_catalog_invalid",
      );
    },
  );

  it("rejects symbolic links inside a Skill package", async () => {
    const fixture = await createFixture();
    const outside = join(fixture.root, "outside.txt");
    await writeFile(outside, "outside", "utf8");
    try {
      await symlink(
        outside,
        join(fixture.skillsRoot, "alpha-skill", "linked.txt"),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }

    await expect(loadFixture(fixture)).rejects.toThrow("skill_catalog_invalid");
  });

  it("enforces Skill count, file count, file size, and total byte limits", async () => {
    const tooManySkills = await createFixture();
    const entries = [];
    for (let index = 0; index < 33; index += 1) {
      const name = `skill-${index}`;
      await tooManySkills.addSkill(
        name,
        validSkill.replace("alpha-skill", name),
      );
      entries.push({
        name,
        path: name,
        requiredCapabilities: ["image.generate"],
      });
    }
    await tooManySkills.writeManifest({ schemaVersion: 1, skills: entries });
    await expect(loadFixture(tooManySkills)).rejects.toThrow(
      "skill_catalog_invalid",
    );

    const tooManyFiles = await createFixture();
    for (let index = 0; index < 256; index += 1) {
      await writeFile(
        join(tooManyFiles.skillsRoot, "alpha-skill", `${index}.txt`),
        "x",
      );
    }
    await expect(loadFixture(tooManyFiles)).rejects.toThrow(
      "skill_catalog_invalid",
    );

    const oversizedSkillDocument = await createFixture({
      content: `${validSkill}${"x".repeat(256 * 1_024)}`,
    });
    await expect(loadFixture(oversizedSkillDocument)).rejects.toThrow(
      "skill_catalog_invalid",
    );

    const oversizedSupportFile = await createFixture();
    await writeFile(
      join(oversizedSupportFile.skillsRoot, "alpha-skill", "large.txt"),
      Buffer.alloc(10 * 1_024 * 1_024 + 1),
    );
    await expect(loadFixture(oversizedSupportFile)).rejects.toThrow(
      "skill_catalog_invalid",
    );
  });

  it("produces a deterministic digest and returns defensive byte copies", async () => {
    const fixture = await createFixture();
    await writeFile(
      join(fixture.skillsRoot, "alpha-skill", "notes.txt"),
      "notes",
    );
    const first = await loadFixture(fixture);
    const second = await loadFixture(fixture);

    expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(second.digest).toBe(first.digest);
    const firstBytes = first.get("alpha-skill").files[0]?.bytes;
    if (!firstBytes) throw new Error("fixture file missing");
    firstBytes[0] = 0;
    expect(first.get("alpha-skill").files[0]?.bytes[0]).not.toBe(0);
    expect(Object.isFrozen(first.list())).toBe(true);
  });

  it("hashes included files in global lexicographic relative-path order", async () => {
    const fixture = await createFixture();
    const betaContent = validSkill.replaceAll("alpha", "beta");
    await fixture.addSkill("beta-skill", betaContent);
    const manifest = {
      schemaVersion: 1,
      skills: [
        {
          name: "beta-skill",
          path: "beta-skill",
          requiredCapabilities: ["image.generate"],
        },
        fixture.manifest.skills[0],
      ],
    };
    await fixture.writeManifest(manifest);

    const catalog = await loadFixture(fixture);
    const expected = createHash("sha256");
    expected.update(canonicalJson(manifest));
    for (const path of ["alpha-skill/SKILL.md", "beta-skill/SKILL.md"]) {
      const bytes = await readFile(join(fixture.skillsRoot, path));
      expected.update(path);
      expected.update("\0");
      expected.update(String(bytes.byteLength));
      expected.update("\0");
      expected.update(createHash("sha256").update(bytes).digest("hex"));
    }
    expect(catalog.digest).toBe(expected.digest("hex"));
  });
});

async function loadRepositoryCatalog(): Promise<BuiltinSkillCatalog> {
  return loadBuiltinSkillCatalog({
    manifestPath: new URL(
      "../../../../../skills/builtin-skills.manifest.json",
      import.meta.url,
    ),
    skillsRoot: new URL("../../../../../skills/", import.meta.url),
  });
}

async function loadFixture(fixture: Awaited<ReturnType<typeof createFixture>>) {
  return loadBuiltinSkillCatalog({
    manifestPath: fixture.manifestPath,
    skillsRoot: fixture.skillsRoot,
  });
}

async function createFixture(options: { content?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "loomic-skill-catalog-"));
  temporaryRoots.push(root);
  const skillsRoot = join(root, "skills");
  const manifestPath = join(skillsRoot, "builtin-skills.manifest.json");
  await mkdir(skillsRoot, { recursive: true });
  const manifest = {
    schemaVersion: 1,
    skills: [
      {
        name: "alpha-skill",
        path: "alpha-skill",
        requiredCapabilities: ["image.generate"],
      },
    ],
  };
  const addSkill = async (name: string, content: string) => {
    const directory = join(skillsRoot, name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "SKILL.md"), content, "utf8");
  };
  const writeManifest = async (value: unknown) => {
    await writeFile(manifestPath, JSON.stringify(value), "utf8");
  };
  await addSkill("alpha-skill", options.content ?? validSkill);
  await writeManifest(manifest);
  return { root, skillsRoot, manifestPath, manifest, addSkill, writeManifest };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}
