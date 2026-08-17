import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  collectArchitectureSources,
  scanArchitectureSources,
} from "../scripts/check-architecture-boundaries.mjs";

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

async function workspacePackageManifests() {
  const packageDirectories = (
    await Promise.all(
      ["apps", "packages"].map(async (workspaceDirectory) =>
        (
          await readdir(path.join(rootDir, workspaceDirectory), {
            withFileTypes: true,
          })
        )
          .filter((entry) => entry.isDirectory())
          .map((entry) => `${workspaceDirectory}/${entry.name}`),
      ),
    )
  ).flat();
  return Promise.all(
    packageDirectories.map(async (directory) => ({
      directory,
      manifest: await readJson(`${directory}/package.json`),
    })),
  );
}

async function sourceFiles(directory) {
  const ignoredDirectories = new Set([
    ".next",
    "dist",
    "generated",
    "node_modules",
  ]);
  const files = [];

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        files.push(...(await sourceFiles(entryPath)));
      }
      continue;
    }

    if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
      files.push(entryPath);
    }
  }

  return files;
}

function isDirectZodImport(source) {
  return /(?:\b(?:from|import)\s*(?:\(\s*)?|\brequire\s*\(\s*)["']zod(?:\/[^"']+)?["']/.test(
    source,
  );
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

test("environment template validator rejects drift without resolving secrets", async () => {
  const { validateEnvironmentContracts } = await import(
    "../scripts/validate-env-template.mjs"
  );
  const issues = validateEnvironmentContracts({
    envTemplate: [
      "OPENAI_API_KEY=placeholder",
      "UNKNOWN_ENV=value",
      "LOOMIC_ALLOW_LOCAL_AGENT_EXECUTE=true",
    ].join("\n"),
    deployments: [
      {
        name: "vercel.json",
        metadata: {
          process: "web",
          variables: ["OPENAI_API_KEY"],
        },
      },
      {
        name: "railway-worker.json",
        metadata: {
          process: "worker",
          variables: ["SUPABASE_URL"],
        },
      },
    ],
    requireCompleteTemplate: false,
  });

  assert.ok(issues.some((issue) => issue.includes("UNKNOWN_ENV")));
  assert.ok(issues.some((issue) => issue.includes("dangerous")));
  assert.ok(issues.some((issue) => issue.includes("public/private")));
  assert.ok(
    issues.some(
      (issue) =>
        issue.includes("railway-worker.json") &&
        issue.includes("SUPABASE_DB_URL"),
    ),
  );
  assert.ok(!issues.join("\n").includes("placeholder"));
});

test("workspace tests run the checked-in environment contract validator", async () => {
  const manifest = await readJson("package.json");

  assert.match(manifest.scripts["validate:env"], /validate-env-template/);
  assert.match(manifest.scripts["test:workspace"], /validate:env/);
});

test("deployment contract binds real API and worker Railway configs", async () => {
  const contract = await readJson("deploy/environment-contract.json");
  const api = await readJson(contract.services.api.configPath);
  const rootRailway = await readJson("railway.json");
  const worker = await readJson(contract.services.worker.configPath);
  const vercel = await readJson(contract.services.web.configPath);
  const serverHealth = await readText("apps/server/src/http/health.ts");

  assert.match(api.deploy.startCommand, /server\.js/);
  assert.equal(contract.services.api.healthPath, "/api/health");
  assert.equal(api.deploy.healthcheckPath, contract.services.api.healthPath);
  assert.equal(
    rootRailway.deploy.healthcheckPath,
    contract.services.api.healthPath,
  );
  assert.ok(
    serverHealth.includes(`app.get("${contract.services.api.healthPath}"`),
  );
  assert.match(worker.deploy.startCommand, /worker\.js/);
  assert.ok(contract.services.worker.variables.includes("SUPABASE_DB_URL"));
  assert.ok(
    contract.services.api.providerAnyOf.some((keys) =>
      keys.includes("OPENAI_API_KEY"),
    ),
  );
  assert.ok(
    contract.services.worker.providerAnyOf.some((keys) =>
      keys.includes("GOOGLE_SERVICE_ACCOUNT_JSON"),
    ),
  );
  assert.equal(vercel.env, undefined);
  assert.match(contract.services.worker.binding, /dashboard/i);
});

test("production server parses environment exactly once before composition", async () => {
  const server = await readText("apps/server/src/server.ts");
  const app = await readText("apps/server/src/app.ts");

  assert.match(
    server,
    /loadServerEnv\(\{\}, process\.env, \{ process: "api" \}\)/,
  );
  assert.match(server, /buildAppFromEnv\(env\)/);
  const productionComposition = app.slice(
    app.indexOf("export function buildAppFromEnv"),
    app.indexOf("export function buildAppWithOverrides"),
  );
  assert.doesNotMatch(productionComposition, /loadServerEnv/);
  assert.match(
    app,
    /buildAppWithOverrides[\s\S]*loadServerEnv\(options\.env\)/,
  );
});

test("Railway validator rejects undeclared shell variables and inexact entrypoints", async () => {
  const { validateEnvironmentContracts } = await import(
    "../scripts/validate-env-template.mjs"
  );
  const issues = validateEnvironmentContracts({
    envTemplate: "",
    requireCompleteTemplate: false,
    serverHealthSource: 'app.get("/api/health"',
    deployments: [
      {
        name: "railway-api.json",
        metadata: {
          binding: "Railway dashboard",
          healthPath: "/api/health",
          platform: "railway",
          process: "api",
          variables: [
            "SUPABASE_URL",
            "SUPABASE_ANON_KEY",
            "SUPABASE_SERVICE_ROLE_KEY",
          ],
        },
        config: {
          $schema: "https://railway.com/railway.schema.json",
          deploy: {
            healthcheckPath: "/api/health",
            startCommand:
              'echo node apps/server/dist/server.js && echo "$UNDECLARED"',
          },
        },
      },
    ],
  });

  assert.ok(issues.some((issue) => issue.includes("exact API entrypoint")));
  assert.ok(
    issues.some(
      (issue) =>
        issue.includes("UNDECLARED") &&
        issue.includes("no environment descriptor"),
    ),
  );
  assert.ok(
    issues.some(
      (issue) =>
        issue.includes("UNDECLARED") &&
        issue.includes("missing from the service contract"),
    ),
  );
});

test("Railway overrides target the Docker runtime filesystem layout", async () => {
  const contract = await readJson("deploy/environment-contract.json");
  const dockerfile = await readText("apps/server/Dockerfile");
  const api = await readJson(contract.services.api.configPath);
  const worker = await readJson(contract.services.worker.configPath);

  assert.match(dockerfile, /WORKDIR \/app/);
  assert.match(
    dockerfile,
    /COPY --from=builder \/workspace\/apps\/server\/dist \.\/dist/,
  );
  assert.equal(contract.services.api.runtimeEntrypoint, "dist/server.js");
  assert.equal(contract.services.worker.runtimeEntrypoint, "dist/worker.js");
  assert.match(api.deploy.startCommand, /exec node dist\/server\.js"$/);
  assert.match(worker.deploy.startCommand, /exec node dist\/worker\.js"$/);
  assert.match(dockerfile, /node dist\/server\.js/);
  assert.match(dockerfile, /node dist\/worker\.js/);
  assert.match(dockerfile, /pnpm --filter @loomic\/config build/);
  assert.ok(
    dockerfile.indexOf("pnpm --filter @loomic/config build") <
      dockerfile.indexOf("pnpm --filter @loomic/server build"),
  );
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
  const manifest = await readJson("packages/config/package.json");

  assert.doesNotMatch(source, /apps\/\*/);
  assert.doesNotMatch(source, /packages\/\*/);
  assert.doesNotMatch(
    source,
    /envDescriptors|parseServerEnvironment|serverEnvironmentSchema/,
  );
  assert.equal(manifest.exports["./server"].default, null);
  assert.equal(typeof manifest.exports["./server"].types, "string");
  assert.equal(manifest.exports["./server"].browser, null);
  assert.equal(typeof manifest.exports["./server"].import, "string");
  assert.match(manifest.scripts.build, /tsc --build[\s\S]*--force/);
});

test("web sources cannot import the server-only config boundary", async () => {
  const files = await sourceFiles(path.join(rootDir, "apps/web"));
  for (const file of files) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /@loomic\/config\/server/);
  }
});

test("shared package placeholder exists for the upcoming contract task", async () => {
  const manifest = await readJson("packages/shared/package.json");

  assert.equal(manifest.name, "@loomic/shared");
  assert.equal(manifest.type, "module");
});

test("workspace packages do not declare Zod 3", async () => {
  const manifests = await workspacePackageManifests();

  for (const { directory, manifest } of manifests) {
    for (const dependencyGroup of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
    ]) {
      const declaredVersion = manifest[dependencyGroup]?.zod;
      if (declaredVersion) {
        assert.doesNotMatch(
          declaredVersion,
          /(?:^|[~^<>=\s])3(?:\.|$)/,
          `${directory} declares Zod 3 in ${dependencyGroup}`,
        );
      }
    }
  }
});

test("every workspace Zod consumer resolves major 4", async () => {
  const manifests = await workspacePackageManifests();
  const consumers = manifests.filter(({ manifest }) =>
    ["dependencies", "devDependencies", "peerDependencies"].some(
      (dependencyGroup) => manifest[dependencyGroup]?.zod,
    ),
  );

  assert.ok(
    consumers.length > 0,
    "expected at least one workspace Zod consumer",
  );

  for (const { directory } of consumers) {
    const packageRequire = createRequire(
      path.join(rootDir, directory, "package.json"),
    );
    const resolvedManifest = packageRequire("zod/package.json");
    assert.equal(
      Number.parseInt(resolvedManifest.version, 10),
      4,
      `${directory} resolves Zod ${resolvedManifest.version}`,
    );
  }
});

test("every package importing Zod declares the central catalog dependency", async () => {
  const manifests = await workspacePackageManifests();
  const workspace = await readText("pnpm-workspace.yaml");

  assert.match(workspace, /catalog:\s*[\s\S]*?zod:\s*\^4(?:\.|$)/);

  for (const { directory, manifest } of manifests) {
    const files = await sourceFiles(path.join(rootDir, directory));
    const importers = [];

    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (isDirectZodImport(source)) {
        importers.push(path.relative(rootDir, file));
      }
    }

    if (importers.length > 0) {
      assert.equal(
        manifest.dependencies?.zod,
        "catalog:",
        `${directory} imports Zod in ${importers.join(", ")} but does not declare the central catalog dependency`,
      );
    }
  }
});

test("Zod import detection covers module forms and compatibility subpaths", () => {
  for (const source of [
    'import { z } from "zod";',
    'import "zod";',
    'const zod = await import("zod/v4");',
    "const zod = require('zod');",
    'export { z } from "zod/v3";',
  ]) {
    assert.equal(isDirectZodImport(source), true, source);
  }

  assert.equal(isDirectZodImport('import "zod-to-json-schema";'), false);
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

test("typecheck builds workspace dependencies in a clean checkout", async () => {
  const turbo = await readJson("turbo.json");

  assert.ok(turbo.tasks.typecheck.dependsOn.includes("^build"));
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

const architectureBoundaryFixtures = [
  {
    name: "module-global registry map",
    path: "apps/server/src/app.ts",
    rule: "instance-owned-registries",
    source: "// composition\nconst providerRegistry = new Map();",
  },
  {
    name: "module-global registry singleton",
    path: "apps/server/src/features/jobs/executors/register-all.ts",
    rule: "instance-owned-registries",
    source: "// registration\nexport const registry = new ProviderRegistry();",
  },
  {
    name: "typed module-global ProviderRegistry",
    path: "apps/server/src/app.ts",
    rule: "instance-owned-registries",
    source:
      "// composition\nconst catalog: ProviderCatalog = new ProviderRegistry();",
  },
  {
    name: "module-global let ExecutorRegistry",
    path: "apps/server/src/worker.ts",
    rule: "instance-owned-registries",
    source: "// composition\nlet active = new ExecutorRegistry();",
  },
  {
    name: "aliased imported module-global ProviderRegistry",
    path: "apps/server/src/app.ts",
    rule: "instance-owned-registries",
    source:
      'import { ProviderRegistry as Registry } from "./registry.js";\nconst active = new Registry();',
  },
  {
    name: "namespace imported module-global ExecutorRegistry",
    path: "apps/server/src/worker.ts",
    rule: "instance-owned-registries",
    source:
      'import * as registries from "./registry.js";\nconst active = new registries.ExecutorRegistry();',
  },
  {
    name: "semantic module-global registry Map",
    path: "apps/server/src/app.ts",
    rule: "instance-owned-registries",
    source:
      "// composition\nlet executorCatalog: Map<string, unknown> = new Map();",
  },
  {
    name: "module-global registry in arbitrary server production module",
    path: "apps/server/src/generation/providers/catalog.ts",
    rule: "instance-owned-registries",
    source: "// catalog\nconst active = new ProviderRegistry();",
  },
  {
    name: "module-global direct provider registry factory",
    path: "apps/server/src/app.ts",
    rule: "instance-owned-registries",
    source: "// composition\nconst active = registerAllProviders(env);",
  },
  {
    name: "module-global aliased executor registry factory",
    path: "apps/server/src/composition/jobs.ts",
    rule: "instance-owned-registries",
    source:
      'import { registerAllExecutors as buildExecutors } from "../features/jobs/executors/register-all.js";\nconst active = buildExecutors(catalog);',
  },
  {
    name: "module-global namespace provider registry factory",
    path: "apps/server/src/composition/providers.ts",
    rule: "instance-owned-registries",
    source:
      'import * as providers from "../generation/providers/register-all.js";\nconst active = providers.registerAllProviders(env);',
  },
  {
    name: "typed module-global registry factory",
    path: "apps/server/src/composition/providers.ts",
    rule: "instance-owned-registries",
    source:
      "// composition\nconst active: ProviderRegistry = buildProviderCatalog(env);",
  },
  {
    name: "aliased typed module-global registry factory",
    path: "apps/server/src/composition/providers.ts",
    rule: "instance-owned-registries",
    source:
      'import type { ProviderRegistry as Registry } from "../generation/providers/registry.js";\nconst active: Registry = buildProviderCatalog(env);',
  },
  {
    name: "namespace typed module-global registry factory",
    path: "apps/server/src/composition/jobs.ts",
    rule: "instance-owned-registries",
    source:
      'import type * as registries from "../features/jobs/job-executor.js";\nconst active: registries.ExecutorRegistry = buildExecutorCatalog();',
  },
  {
    name: "union typed module-global registry",
    path: "apps/server/src/composition/providers.ts",
    rule: "instance-owned-registries",
    source:
      "// composition\nconst active: ProviderRegistry | undefined = undefined;",
  },
  {
    name: "nullable typed module-global registry",
    path: "apps/server/src/composition/providers.ts",
    rule: "instance-owned-registries",
    source: "// composition\nconst active: ProviderRegistry | null = null;",
  },
  {
    name: "namespace union typed module-global registry",
    path: "apps/server/src/composition/jobs.ts",
    rule: "instance-owned-registries",
    source:
      'import type * as registries from "../features/jobs/job-executor.js";\nconst active: registries.ExecutorRegistry | null = null;',
  },
  {
    name: "generic wrapped module-global registry type",
    path: "apps/server/src/composition/providers.ts",
    rule: "instance-owned-registries",
    source:
      "// composition\nconst active: Readonly<ProviderRegistry> = buildProviderCatalog();",
  },
  {
    name: "parenthesized intersection module-global registry type",
    path: "apps/server/src/composition/providers.ts",
    rule: "instance-owned-registries",
    source:
      "// composition\nconst active: (ProviderRegistry & { sealed: true }) = buildProviderCatalog();",
  },
  {
    name: "route-local isZodError helper",
    path: "apps/server/src/http/projects.ts",
    rule: "shared-zod-boundary",
    source: "// route\nfunction isZodError(error) { return false; }",
  },
  {
    name: "route-local issues duck typing",
    path: "apps/server/src/http/canvases.ts",
    rule: "shared-zod-boundary",
    source: '// route\nif ("issues" in error) throw error;',
  },
  {
    name: "route-local cast then issues access",
    path: "apps/server/src/http/canvases.ts",
    rule: "shared-zod-boundary",
    source:
      "// route\nif ((error as { issues?: unknown }).issues) throw error;",
  },
  {
    name: "route-local ZodError name check",
    path: "apps/server/src/http/skills.ts",
    rule: "shared-zod-boundary",
    source: "// route\nif (error.name === 'ZodError') throw error;",
  },
  {
    name: "direct Web fetch",
    path: "apps/web/src/lib/server-api.ts",
    rule: "schema-aware-web-api",
    source: '// api\nconst response = await fetch("/api/projects");',
  },
  {
    name: "unchecked response json",
    path: "apps/web/src/lib/server-api.ts",
    rule: "schema-aware-web-api",
    source: "// api\nasync function load() { return await response.json(); }",
  },
  {
    name: "unchecked renamed response json",
    path: "apps/web/src/lib/server-api.ts",
    rule: "schema-aware-web-api",
    source: "// api\nasync function load() { return await res.json(); }",
  },
  {
    name: "unchecked response cast",
    path: "apps/web/src/lib/server-api.ts",
    rule: "schema-aware-web-api",
    source: "// api\nfunction load() { return response as ProjectList; }",
  },
  {
    name: "unchecked awaited json cast",
    path: "apps/web/src/lib/server-api.ts",
    rule: "schema-aware-web-api",
    source:
      "// api\nasync function load() { return (await response.json()) as ProjectList; }",
  },
  {
    name: "direct queued-job orchestration",
    path: "apps/server/src/http/jobs.ts",
    rule: "generation-use-case-boundary",
    source: "// adapter\nawait jobService.createJob(input);",
  },
  {
    name: "direct jobService enqueue orchestration",
    path: "apps/server/src/agent/runtime.ts",
    rule: "generation-use-case-boundary",
    source: "// adapter\nawait jobService.enqueueGeneration(input);",
  },
  {
    name: "direct jobService submit orchestration",
    path: "apps/server/src/http/generate.ts",
    rule: "generation-use-case-boundary",
    source: "// adapter\nawait jobService.submitVideo(input);",
  },
  {
    name: "direct Skill importer",
    path: "apps/server/src/http/skills.ts",
    rule: "skill-import-use-case-boundary",
    source:
      "// adapter\nfunction importExternal() { return importSkillFromUrl(sourceUrl); }",
  },
  {
    name: "namespace direct Skill importer",
    path: "apps/server/src/http/skills.ts",
    rule: "skill-import-use-case-boundary",
    source:
      "// adapter\nfunction importExternal() { return legacy.importSkillFromUrl(sourceUrl); }",
  },
  {
    name: "deep Agent canvas write",
    path: "apps/server/src/agent/tools/image-generate.ts",
    rule: "canvas-application-boundary",
    source: '// tool\nawait client.from("canvases").update({ content });',
  },
  {
    name: "deep Agent media insert",
    path: "apps/server/src/agent/tools/video-generate.ts",
    rule: "canvas-application-boundary",
    source: '// tool\nawait client.from("project_assets").insert(asset);',
  },
  {
    name: "legacy Agent insertGeneratedMediaElement call",
    path: "apps/server/src/agent/tools/image-generate.ts",
    rule: "canvas-application-boundary",
    source: "// tool\nawait insertGeneratedMediaElement(input);",
  },
  {
    name: "namespace legacy Agent insertGeneratedMediaElement call",
    path: "apps/server/src/agent/tools/image-generate.ts",
    rule: "canvas-application-boundary",
    source: "// tool\nawait legacy.insertGeneratedMediaElement(input);",
  },
  {
    name: "legacy Agent persistGeneratedMedia call",
    path: "apps/server/src/agent/tools/video-generate.ts",
    rule: "canvas-application-boundary",
    source: "// tool\nawait persistGeneratedMedia(input);",
  },
  {
    name: "namespace legacy Agent persistGeneratedMedia call",
    path: "apps/server/src/agent/tools/video-generate.ts",
    rule: "canvas-application-boundary",
    source: "// tool\nawait legacy.persistGeneratedMedia(input);",
  },
  {
    name: "legacy Agent writeCanvasContent call",
    path: "apps/server/src/agent/runtime.ts",
    rule: "canvas-application-boundary",
    source: "// runtime\nawait writeCanvasContent(input);",
  },
  {
    name: "namespace legacy Agent writeCanvasContent call",
    path: "apps/server/src/agent/runtime.ts",
    rule: "canvas-application-boundary",
    source: "// runtime\nawait legacy.writeCanvasContent(input);",
  },
];

for (const fixture of architectureBoundaryFixtures) {
  test(`architecture boundary rejects ${fixture.name} with file and line evidence`, () => {
    const findings = scanArchitectureSources([fixture]);
    assert.equal(findings.length, 1, fixture.name);
    assert.equal(findings[0].rule, fixture.rule, fixture.name);
    assert.match(
      findings[0].evidence,
      new RegExp(`^${fixture.path.replaceAll("/", "\\/")}:2 `),
      fixture.name,
    );
  });
}

test("registry boundary allows function-local composition", () => {
  const findings = scanArchitectureSources([
    {
      path: "apps/server/src/app.ts",
      source:
        "export function buildApp() {\nconst registry = new ProviderRegistry();\nreturn registry;\n}",
    },
  ]);

  assert.deepEqual(findings, []);
});

test("registry boundary allows unrelated module-global Maps", () => {
  const findings = scanArchitectureSources([
    {
      path: "apps/server/src/app.ts",
      source: "const requestTimers = new Map<string, number>();",
    },
  ]);

  assert.deepEqual(findings, []);
});

test("registry boundary allows function-local registry factories", () => {
  const findings = scanArchitectureSources([
    {
      path: "apps/server/src/generation/providers/catalog.ts",
      source:
        "export function build() {\nconst registry = registerAllProviders(env);\nreturn registry;\n}",
    },
  ]);

  assert.deepEqual(findings, []);
});

test("registry boundary allows unrelated module-global factories", () => {
  const findings = scanArchitectureSources([
    {
      path: "apps/server/src/app.ts",
      source: "const formatter = registerAllFormatters(options);",
    },
  ]);

  assert.deepEqual(findings, []);
});

for (const fixture of [
  {
    name: "unrelated union types",
    source: "const active: string | undefined = undefined;",
  },
  {
    name: "unrelated generic wrapper types",
    source: "const active: Readonly<Unrelated> = buildUnrelated();",
  },
  {
    name: "registry factory capability types",
    source: "const createRegistry: Factory<ProviderRegistry> = buildRegistry;",
  },
  {
    name: "registry constructor capability types",
    source:
      "const RegistryClass: Constructor<ProviderRegistry> = ProviderRegistry;",
  },
  {
    name: "registry function capability types",
    source: "const createRegistry: () => ProviderRegistry = buildRegistry;",
  },
]) {
  test(`registry boundary allows ${fixture.name}`, () => {
    const findings = scanArchitectureSources([
      {
        path: "apps/server/src/composition/unrelated.ts",
        source: fixture.source,
      },
    ]);

    assert.deepEqual(findings, []);
  });
}

const forbiddenArchitectureText =
  'fetch("/"); response.json(); response as Project; jobService.createJob(); jobService.enqueueGeneration(); importSkillFromUrl(); insertGeneratedMediaElement(); persistGeneratedMedia(); writeCanvasContent(); client.from("canvases").update(); client.from("project_assets").insert(); error.name === "ZodError"; "issues" in error; function isZodError; const providerRegistry = new Map(); new ProviderRegistry();';

for (const fixture of [
  {
    name: "comments",
    source: `// ${forbiddenArchitectureText}`,
  },
  {
    name: "ordinary strings",
    source: `const documentation = ${JSON.stringify(forbiddenArchitectureText)};`,
  },
  {
    name: "template text",
    source: `const documentation = \`${forbiddenArchitectureText}\`;`,
  },
]) {
  test(`architecture boundary ignores forbidden words in ${fixture.name}`, () => {
    const findings = scanArchitectureSources(
      [
        "apps/server/src/app.ts",
        "apps/server/src/http/projects.ts",
        "apps/server/src/http/jobs.ts",
        "apps/server/src/http/skills.ts",
        "apps/server/src/agent/tools/image-generate.ts",
        "apps/web/src/lib/server-api.ts",
      ].map((path) => ({ path, source: fixture.source })),
    );

    assert.deepEqual(findings, []);
  });
}

test("architecture boundary fails closed on malformed TypeScript", () => {
  const secret = "must-not-appear-in-diagnostics";

  assert.throws(
    () =>
      scanArchitectureSources([
        {
          path: "apps/server/src/http/projects.ts",
          source: `const credential = ${JSON.stringify(secret)};\nfunction broken(`,
        },
      ]),
    (error) => {
      assert.match(error.message, /^apps\/server\/src\/http\/projects\.ts:2 /);
      assert.match(error.message, /invalid TypeScript syntax/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );
});

test("phase 1 architecture boundaries remain enforced across migrated sources", async () => {
  const sources = await collectArchitectureSources(rootDir);
  const sourcePaths = new Set(sources.map(({ path }) => path));
  for (const requiredPath of [
    "apps/server/src/app.ts",
    "apps/server/src/worker.ts",
    "apps/server/src/generation/providers/register-all.ts",
    "apps/server/src/features/jobs/executors/register-all.ts",
    "apps/server/src/agent/tools/image-generate.ts",
    "apps/server/src/agent/tools/video-generate.ts",
  ]) {
    assert.ok(
      sourcePaths.has(requiredPath),
      `architecture scan omitted ${requiredPath}`,
    );
  }
  const findings = scanArchitectureSources(sources);

  assert.deepEqual(
    findings,
    [],
    findings.map(({ evidence, message }) => `${evidence}${message}`).join("\n"),
  );
});
