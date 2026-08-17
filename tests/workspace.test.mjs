import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(dirname, "..");

async function readJson(relativePath) {
  const filePath = path.join(rootDir, relativePath);
  const content = await readFile(filePath, "utf8");
  return JSON.parse(content);
}

async function readText(relativePath) {
  const filePath = path.join(rootDir, relativePath);
  return readFile(filePath, "utf8");
}

test("root manifest exposes dev, build, test, and lint scripts", async () => {
  const manifest = await readJson("package.json");

  assert.equal(typeof manifest.scripts?.dev, "string");
  assert.equal(typeof manifest.scripts?.build, "string");
  assert.equal(typeof manifest.scripts?.test, "string");
  assert.equal(typeof manifest.scripts?.lint, "string");
});

test("workspace includes apps and packages globs", async () => {
  const workspace = await readText("pnpm-workspace.yaml");

  assert.match(workspace, /apps\/\*/);
  assert.match(workspace, /packages\/\*/);
});

test("root test command wires node:test and turbo package tests", async () => {
  const manifest = await readJson("package.json");

  assert.match(manifest.scripts["test:workspace"], /node --test/);
  assert.match(manifest.scripts["test:packages"], /turbo run test/);
  assert.match(manifest.scripts.test, /test:workspace/);
  assert.match(manifest.scripts.test, /test:packages/);
});

test("vitest workspace config exists for later package-level adoption", async () => {
  const workspaceConfig = await readText("vitest.workspace.ts");

  assert.match(workspaceConfig, /defineWorkspace/);
  assert.match(workspaceConfig, /tests\/\*\*\/\*\.test\.mjs/);
});

for (const appName of ["web", "server"]) {
  test(`${appName} app scripts perform real validation instead of placeholder logs`, async () => {
    const manifest = await readJson(`apps/${appName}/package.json`);

    assert.equal(typeof manifest.scripts?.build, "string");
    assert.equal(typeof manifest.scripts?.test, "string");
    assert.equal(typeof manifest.scripts?.typecheck, "string");
    assert.doesNotMatch(manifest.scripts.build, /placeholder/i);
    assert.doesNotMatch(manifest.scripts.build, /console\.log/);
    assert.doesNotMatch(manifest.scripts.test, /placeholder/i);
    assert.doesNotMatch(manifest.scripts.test, /console\.log/);
    assert.doesNotMatch(manifest.scripts.typecheck, /placeholder/i);
    assert.doesNotMatch(manifest.scripts.typecheck, /console\.log/);
  });
}

test("@loomic/config exports a single low-drift package contract", async () => {
  const source = await readText("packages/config/src/index.ts");

  assert.doesNotMatch(source, /apps\/\*/);
  assert.doesNotMatch(source, /packages\/\*/);
});

test("shared package placeholder exists for the upcoming contract task", async () => {
  const manifest = await readJson("packages/shared/package.json");

  assert.equal(manifest.name, "@loomic/shared");
  assert.equal(manifest.type, "module");
});

test("root lint baseline is wired through Biome", async () => {
  const manifest = await readJson("package.json");
  const biomeConfig = await readJson("biome.json");

  assert.equal(typeof manifest.devDependencies["@biomejs/biome"], "string");
  assert.match(manifest.scripts.lint, /biome/);
  assert.match(biomeConfig.$schema, /biome/);
  assert.equal(biomeConfig.formatter.enabled, true);
  assert.equal(biomeConfig.linter.enabled, true);
});

test("server build emits and runs production JavaScript", async () => {
  const manifest = await readJson("apps/server/package.json");

  assert.match(manifest.scripts.build, /tsc -p tsconfig\.build\.json/);
  assert.doesNotMatch(manifest.scripts.build, /validate-foundation-app/);
  assert.equal(manifest.scripts.start, "node dist/server.js");
  assert.equal(manifest.scripts["start:worker"], "node dist/worker.js");
});

test("web production build does not ignore TypeScript errors", async () => {
  const config = await readText("apps/web/next.config.ts");

  assert.doesNotMatch(config, /ignoreBuildErrors\s*:\s*true/);
});

test("server image runs compiled output without tsx", async () => {
  const dockerfile = await readText("apps/server/Dockerfile");

  assert.match(dockerfile, /pnpm --filter @loomic\/server build/);
  assert.match(dockerfile, /node dist\/server\.js/);
  assert.doesNotMatch(dockerfile, /node --import tsx src\/server\.ts/);
});

test("root CI command includes all four quality gates", async () => {
  const manifest = await readJson("package.json");

  assert.match(manifest.scripts["ci:check"], /pnpm lint/);
  assert.match(manifest.scripts["ci:check"], /pnpm typecheck/);
  assert.match(manifest.scripts["ci:check"], /pnpm test/);
  assert.match(manifest.scripts["ci:check"], /pnpm build/);
});

test("CI uses the pinned pnpm version and frozen installs", async () => {
  const manifest = await readJson("package.json");
  const workflow = await readText(".github/workflows/ci.yml");
  const pnpmVersion = manifest.packageManager.split("@")[1];

  assert.match(
    workflow,
    new RegExp(`version: ${pnpmVersion.replaceAll(".", "\\.")}`),
  );
  assert.match(workflow, /pnpm install --frozen-lockfile/);
  assert.match(workflow, /pnpm ci:check/);
  assert.match(workflow, /supabase db reset/);
  assert.match(workflow, /docker build/);
});

test("CI runs database permission tests and a container smoke test", async () => {
  const workflow = await readText(".github/workflows/ci.yml");

  assert.match(workflow, /supabase test db/);
  assert.match(workflow, /docker run --rm/);
  assert.match(workflow, /app-load-ok/);
});
