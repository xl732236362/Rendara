import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { load as loadYaml } from "js-yaml";
import { z } from "zod";

const MAX_SKILLS = 32;
const MAX_CATALOG_BYTES = 64 * 1_024 * 1_024;
const MAX_FILES_PER_SKILL = 256;
const MAX_SKILL_BYTES = 10 * 1_024 * 1_024;
const MAX_SKILL_DOCUMENT_BYTES = 256 * 1_024;
const MAX_SUPPORT_FILE_BYTES = 10 * 1_024 * 1_024;

const capabilitySchema = z.enum([
  "skill.read",
  "canvas.read",
  "canvas.mutate",
  "asset.persist",
  "image.generate",
  "video.generate",
  "brand_kit.read",
  "project.search",
  "agent.delegate",
]);
export type BuiltinSkillCapability = z.infer<typeof capabilitySchema>;

const skillNameSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const manifestEntrySchema = z
  .object({
    name: skillNameSchema,
    path: z.string().min(1),
    requiredCapabilities: z.array(capabilitySchema),
  })
  .strict();
const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    skills: z.array(manifestEntrySchema).max(MAX_SKILLS),
  })
  .strict();
const frontmatterSchema = z
  .object({
    name: skillNameSchema,
    description: z.string().trim().min(1).max(1_024),
    license: z.string().trim().min(1).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type BuiltinSkillSummary = Readonly<{
  name: string;
  description: string;
  requiredCapabilities: readonly BuiltinSkillCapability[];
}>;

export type BuiltinSkillFile = Readonly<{
  path: string;
  bytes: Uint8Array;
}>;

export type BuiltinSkill = BuiltinSkillSummary &
  Readonly<{ files: readonly BuiltinSkillFile[] }>;

export interface BuiltinSkillCatalog {
  readonly digest: string;
  list(): readonly BuiltinSkillSummary[];
  get(name: string): BuiltinSkill;
}

type StoredSkill = BuiltinSkillSummary &
  Readonly<{
    files: readonly Readonly<{ path: string; bytes: Uint8Array }>[];
  }>;

export async function loadBuiltinSkillCatalog(options: {
  manifestPath: string | URL;
  skillsRoot: string | URL;
}): Promise<BuiltinSkillCatalog> {
  try {
    const manifestPath = toPath(options.manifestPath);
    const skillsRoot = toPath(options.skillsRoot);
    const rootStats = await lstat(skillsRoot);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) invalid();
    const canonicalRoot = await realpath(skillsRoot);
    const manifestBytes = await readFile(manifestPath);
    const manifest = manifestSchema.parse(
      JSON.parse(manifestBytes.toString("utf8")),
    );
    assertUnique(manifest.skills.map((entry) => entry.name));
    assertUnique(manifest.skills.map((entry) => entry.path));

    const digest = createHash("sha256");
    digest.update(canonicalJson(manifest));
    const digestFiles: Array<{
      path: string;
      byteLength: number;
      sha256: string;
    }> = [];
    const stored = new Map<string, StoredSkill>();
    let catalogBytes = 0;

    for (const entry of manifest.skills) {
      validateRelativePath(entry.path);
      const skillRoot = resolve(canonicalRoot, entry.path);
      assertContained(canonicalRoot, skillRoot);
      const skillRootStats = await lstat(skillRoot);
      if (!skillRootStats.isDirectory() || skillRootStats.isSymbolicLink()) {
        invalid();
      }
      const canonicalSkillRoot = await realpath(skillRoot);
      assertContained(canonicalRoot, canonicalSkillRoot);

      const filePaths = await collectFiles(canonicalSkillRoot);
      if (filePaths.length === 0 || filePaths.length > MAX_FILES_PER_SKILL) {
        invalid();
      }
      const skillDocument = filePaths.find((path) => path === "SKILL.md");
      if (!skillDocument) invalid();

      let skillBytes = 0;
      const files: Array<Readonly<{ path: string; bytes: Uint8Array }>> = [];
      for (const path of filePaths) {
        const absolutePath = resolve(canonicalSkillRoot, path);
        assertContained(canonicalSkillRoot, absolutePath);
        const stats = await lstat(absolutePath);
        if (!stats.isFile() || stats.isSymbolicLink()) invalid();
        if (
          (path === "SKILL.md" && stats.size > MAX_SKILL_DOCUMENT_BYTES) ||
          (path !== "SKILL.md" && stats.size > MAX_SUPPORT_FILE_BYTES)
        ) {
          invalid();
        }
        const bytes = Uint8Array.from(await readFile(absolutePath));
        skillBytes += bytes.byteLength;
        catalogBytes += bytes.byteLength;
        if (skillBytes > MAX_SKILL_BYTES || catalogBytes > MAX_CATALOG_BYTES) {
          invalid();
        }
        const digestPath = `${entry.path}/${path}`.replaceAll("\\", "/");
        digestFiles.push({
          path: digestPath,
          byteLength: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
        files.push(Object.freeze({ path, bytes }));
      }

      const documentBytes = files.find(
        (file) => file.path === "SKILL.md",
      )?.bytes;
      if (!documentBytes) invalid();
      const frontmatter = parseFrontmatter(
        Buffer.from(documentBytes).toString("utf8"),
      );
      if (frontmatter.name !== entry.name) invalid();
      const requiredCapabilities = Object.freeze(
        [...new Set(entry.requiredCapabilities)].sort(),
      );
      stored.set(
        entry.name,
        Object.freeze({
          name: entry.name,
          description: frontmatter.description,
          requiredCapabilities,
          files: Object.freeze(files),
        }),
      );
    }

    for (const file of digestFiles.sort((left, right) =>
      left.path.localeCompare(right.path),
    )) {
      digest.update(file.path);
      digest.update("\0");
      digest.update(String(file.byteLength));
      digest.update("\0");
      digest.update(file.sha256);
    }

    const summaries = Object.freeze(
      [...stored.values()]
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((skill) =>
          Object.freeze({
            name: skill.name,
            description: skill.description,
            requiredCapabilities: skill.requiredCapabilities,
          }),
        ),
    );
    const catalogDigest = digest.digest("hex");
    return Object.freeze({
      digest: catalogDigest,
      list: () => summaries,
      get(name: string) {
        const skill = stored.get(name);
        if (!skill) throw new Error("skill_not_found");
        return Object.freeze({
          name: skill.name,
          description: skill.description,
          requiredCapabilities: skill.requiredCapabilities,
          files: Object.freeze(
            skill.files.map((file) =>
              Object.freeze({
                path: file.path,
                bytes: Uint8Array.from(file.bytes),
              }),
            ),
          ),
        });
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message === "skill_not_found") {
      throw error;
    }
    if (error instanceof Error && error.message === "skill_catalog_invalid") {
      throw error;
    }
    throw new Error("skill_catalog_invalid", { cause: error });
  }
}

export function repositoryBuiltinSkillPaths() {
  const candidates = [
    new URL("../../../../../skills/", import.meta.url),
    new URL("../../../../skills/", import.meta.url),
    new URL("file:///opt/loomic/skills/"),
  ];
  const skillsRoot = candidates.find((candidate) => existsSync(candidate));
  if (!skillsRoot) throw new Error("skill_catalog_invalid");
  return Object.freeze({
    skillsRoot,
    manifestPath: new URL("builtin-skills.manifest.json", skillsRoot),
  });
}

export function loadRepositoryBuiltinSkillCatalog() {
  return loadBuiltinSkillCatalog(repositoryBuiltinSkillPaths());
}

async function collectFiles(root: string): Promise<string[]> {
  const collected: string[] = [];
  async function visit(directory: string, prefix: string) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = resolve(directory, entry.name);
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const stats = await lstat(absolutePath);
      if (stats.isSymbolicLink()) invalid();
      if (entry.isDirectory()) {
        await visit(absolutePath, path);
      } else if (entry.isFile()) {
        collected.push(path);
      } else {
        invalid();
      }
      if (collected.length > MAX_FILES_PER_SKILL) invalid();
    }
  }
  await visit(root, "");
  return collected.sort((left, right) => left.localeCompare(right));
}

function parseFrontmatter(source: string) {
  if (!source.startsWith("---\n")) invalid();
  const end = source.indexOf("\n---\n", 4);
  if (end < 0) invalid();
  return frontmatterSchema.parse(loadYaml(source.slice(4, end)));
}

function validateRelativePath(path: string) {
  if (
    isAbsolute(path) ||
    path.includes("\\") ||
    path
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    invalid();
  }
}

function assertContained(root: string, candidate: string) {
  const pathFromRoot = relative(root, candidate);
  if (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) &&
      pathFromRoot !== ".." &&
      !isAbsolute(pathFromRoot))
  ) {
    return;
  }
  invalid();
}

function assertUnique(values: readonly string[]) {
  if (new Set(values).size !== values.length) invalid();
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

function toPath(value: string | URL) {
  return value instanceof URL ? fileURLToPath(value) : resolve(value);
}

function invalid(): never {
  throw new Error("skill_catalog_invalid");
}
