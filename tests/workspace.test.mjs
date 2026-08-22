import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  collectArchitectureSources,
  collectPhase6AArchitectureSources,
  scanArchitectureSources,
  scanPhase6AArchitectureSources,
} from "../scripts/check-architecture-boundaries.mjs";
import * as phase6ABoundaries from "../scripts/check-architecture-boundaries.mjs";

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

async function pathExists(relativePath) {
  return access(path.join(rootDir, relativePath)).then(
    () => true,
    () => false,
  );
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

test("project asset storage configuration matches public URL generation", async () => {
  const config = await readText("supabase/config.toml");
  const migration = await readText(
    "supabase/migrations/20260326000001_public_project_assets_bucket.sql",
  );

  assert.doesNotMatch(config, /\[storage\.buckets\.project-assets\]/);
  assert.match(
    migration,
    /update\s+storage\.buckets\s+set\s+public\s*=\s*true\s+where\s+id\s*=\s*'project-assets'/i,
  );
});

test("dynamic Skill product and execution paths are removed", async () => {
  const forbiddenPaths = [
    "apps/server/src/application/skills",
    "apps/server/src/features/skills",
    "apps/server/src/http/skills.ts",
    "apps/server/src/http/skills-marketplace.ts",
    "apps/web/src/app/(workspace)/skills",
    "apps/web/src/components/skills",
    "packages/shared/src/skill-contracts.ts",
  ];
  const existingPaths = [];
  for (const relativePath of forbiddenPaths) {
    if (await pathExists(relativePath)) existingPaths.push(relativePath);
  }

  const sources = await Promise.all(
    [
      "apps/server/src/app.ts",
      "apps/server/src/application/use-cases.ts",
      "apps/web/src/components/app-sidebar.tsx",
      "apps/web/src/components/chat-sidebar.tsx",
      "apps/web/src/lib/server-api.ts",
      "packages/shared/src/contracts.ts",
      "packages/shared/src/index.ts",
    ].map(async (relativePath) => ({
      relativePath,
      source: await readText(relativePath),
    })),
  );
  const forbiddenSource =
    /(?:application|features)\/skills|register(?:Skill|Marketplace)Routes|["']\/api\/(?:workspaces\/)?skills|["']\/skills["']|mentionType\s*:\s*z\.literal\(["']skill["']\)|skill-contracts/;
  const sourceViolations = sources
    .filter(({ source }) => forbiddenSource.test(source))
    .map(({ relativePath }) => relativePath);

  assert.deepEqual(
    { existingPaths, sourceViolations },
    { existingPaths: [], sourceViolations: [] },
  );
});

test("phase 3 keeps Agent authority manifest-only, tool-only, and canvas-scoped", async () => {
  const manifest = await readJson("skills/builtin-skills.manifest.json");
  const runtime = await readText("apps/server/src/agent/runtime.ts");
  const loomicAgent = await readText("apps/server/src/agent/loomic-agent.ts");
  const authority = await readText("apps/server/src/agent/capabilities.ts");
  const serverManifest = await readJson("apps/server/package.json");
  const removalMigration = await readText(
    "supabase/migrations/20260819000001_phase3_remove_dynamic_skills.sql",
  );

  assert.deepEqual(manifest, {
    schemaVersion: 1,
    skills: [
      {
        name: "json-image-prompt",
        path: "json-image-prompt",
        requiredCapabilities: ["image.generate"],
      },
    ],
  });
  assert.doesNotMatch(
    JSON.stringify(manifest),
    /canvas-design|execute|python/i,
  );
  assert.doesNotMatch(runtime, /<canvas_state>|buildCanvasSummaryForContext/);
  assert.match(loomicAgent, /options\.executionContext[\s\S]*capabilities/);
  assert.match(authority, /FORBIDDEN_AGENT_TOOL_NAMES/);
  assert.equal(serverManifest.dependencies?.deepagents, undefined);
  for (const relation of ["skill_files", "workspace_skills", "skills"]) {
    assert.match(
      removalMigration,
      new RegExp(`drop table if exists public\\.${relation}`),
    );
  }
  assert.doesNotMatch(
    removalMigration,
    /create\s+(?:table|view)|archive|compatib/i,
  );
  const acceptedAuthority = authority.match(
    /PRODUCTION_AGENT_CAPABILITIES\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\s*satisfies/,
  )?.[1];
  assert.ok(
    acceptedAuthority,
    "production accepted authority must be explicit",
  );
  assert.match(acceptedAuthority, /brand_kit\.read/);
  assert.doesNotMatch(acceptedAuthority, /project\.search/);
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
      "LOOMIC_ALLOW_EXTERNAL_SKILL_IMPORT=true",
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
  assert.ok(
    issues.some((issue) =>
      issue.includes("LOOMIC_ALLOW_EXTERNAL_SKILL_IMPORT"),
    ),
  );
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

test("environment template requires placeholders for pagination cursor secrets", async () => {
  const { validateEnvironmentContracts } = await import(
    "../scripts/validate-env-template.mjs"
  );
  const activeSecret = "active-pagination-signing-secret-32-bytes";
  const previousSecret = "previous-pagination-signing-secret-32-bytes";
  const issues = validateEnvironmentContracts({
    envTemplate: [
      `LOOMIC_PAGINATION_CURSOR_ACTIVE_KEY=${activeSecret}`,
      `LOOMIC_PAGINATION_CURSOR_PREVIOUS_KEY=${previousSecret}`,
    ].join("\n"),
    deployments: [],
    requireCompleteTemplate: false,
  });

  assert.ok(
    issues.some((issue) =>
      issue.includes("LOOMIC_PAGINATION_CURSOR_ACTIVE_KEY"),
    ),
  );
  assert.ok(
    issues.some((issue) =>
      issue.includes("LOOMIC_PAGINATION_CURSOR_PREVIOUS_KEY"),
    ),
  );
  assert.doesNotMatch(issues.join("\n"), new RegExp(activeSecret));
  assert.doesNotMatch(issues.join("\n"), new RegExp(previousSecret));
});

test("deployment contract binds real API and worker Railway configs", async () => {
  const contract = await readJson("deploy/environment-contract.json");
  const api = await readJson(contract.services.api.configPath);
  const rootRailway = await readJson("railway.json");
  const worker = await readJson(contract.services.worker.configPath);
  const vercel = await readJson(contract.services.web.configPath);
  const serverHealth = await readText("apps/server/src/http/health.ts");

  assert.match(api.deploy.startCommand, /server\.js/);
  assert.equal(contract.services.api.healthPath, "/api/health/realtime");
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
  {
    name: "direct background job lifecycle update",
    path: "apps/server/src/worker.ts",
    rule: "phase2-persistence-boundary",
    source:
      '// worker\nawait client.from("background_jobs").update({ status: "succeeded" });',
  },
  {
    name: "direct Canvas content update",
    path: "apps/server/src/features/canvas/legacy-writer.ts",
    rule: "phase2-persistence-boundary",
    source:
      '// writer\nawait client.from("canvases").update({ content: next });',
  },
  {
    name: "generation lifecycle compensation",
    path: "apps/server/src/features/jobs/legacy-settlement.ts",
    rule: "phase2-persistence-boundary",
    source: "// settlement\nawait credits.compensateGeneration(command);",
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

const phase6AArchitectureFixtures = [
  {
    name: "raw query-key arrays outside the key factory",
    path: "apps/web/src/components/project-list.tsx",
    rule: "query-key-factory-boundary",
    source:
      'useQuery({ queryKey: ["projects", workspaceId], queryFn: loadProjects });',
  },
  {
    name: "raw query-key arrays through a lexical constant",
    path: "apps/web/src/components/project-list.tsx",
    rule: "query-key-factory-boundary",
    source:
      'const raw = ["projects", workspaceId] as const;\nuseQuery({ queryKey: raw, queryFn: loadProjects });',
  },
  {
    name: "local queryKeys impersonation",
    path: "apps/web/src/components/project-list.tsx",
    rule: "query-key-factory-boundary",
    source:
      'const queryKeys = { workspace: { projects: () => ["forged"] } };\nuseQuery({ queryKey: queryKeys.workspace.projects(), queryFn: loadProjects });',
  },
  {
    name: "aliased local query-key factory impersonation",
    path: "apps/web/src/components/project-list.tsx",
    rule: "query-key-factory-boundary",
    source:
      'const forged = { workspace: { projects: () => ["forged"] } };\nconst queryKeys = forged;\nuseQuery({ queryKey: queryKeys.workspace.projects(), queryFn: loadProjects });',
  },
  {
    name: "default-imported queryKeys impersonation",
    path: "apps/web/src/components/project-list.tsx",
    rule: "query-key-factory-boundary",
    source:
      'import queryKeys from "../lib/not-query-keys";\nuseQuery({ queryKey: queryKeys.workspace.projects(), queryFn: loadProjects });',
  },
  {
    name: "namespace-imported queryKeys impersonation",
    path: "apps/web/src/components/project-list.tsx",
    rule: "query-key-factory-boundary",
    source:
      'import * as forged from "../lib/not-query-keys";\nuseQuery({ queryKey: forged.queryKeys.workspace.projects(), queryFn: loadProjects });',
  },
  {
    name: "identity-derived resources under global keys",
    path: "apps/web/src/lib/query/keys.ts",
    rule: "identity-scoped-query-keys",
    source:
      'export const queryKeys = { global: { projects: (workspaceId: string) => ["global", "projects", workspaceId] as const } };',
  },
  {
    name: "global query-key factories with arbitrary parameter names",
    path: "apps/web/src/lib/query/keys.ts",
    rule: "identity-scoped-query-keys",
    source:
      'export const queryKeys = { global: { projects: (scope: string) => ["global", "projects", scope] as const } };',
  },
  {
    name: "global query-key factories forwarding scoped arguments",
    path: "apps/web/src/lib/query/keys.ts",
    rule: "identity-scoped-query-keys",
    source:
      'const scoped = "workspace";\nfunction makeKey(value: string) { return ["global", value]; }\nexport const queryKeys = { global: { projects: () => makeKey(scoped) } };',
  },
  {
    name: "global query-key closures capturing scoped object properties",
    path: "apps/web/src/lib/query/keys.ts",
    rule: "identity-scoped-query-keys",
    source:
      'const viewer = getViewer();\nconst owner = viewer.user;\nconst identity = owner.id;\nexport const queryKeys = { global: { projects: () => ["global", identity] } };',
  },
  {
    name: "global query-key closures capturing scoped parameters",
    path: "apps/web/src/lib/query/keys.ts",
    rule: "identity-scoped-query-keys",
    source:
      'export function createKeys(workspace: Workspace) { const scope = workspace.id; return { global: { projects: () => ["global", scope] } }; }',
  },
  {
    name: "global query-key closures capturing multi-level identity aliases",
    path: "apps/web/src/lib/query/keys.ts",
    rule: "identity-scoped-query-keys",
    source:
      'const sessionId = currentSession.id;\nconst first = sessionId;\nconst second = first;\nexport const queryKeys = { global: { messages: () => ["global", second] } };',
  },
  {
    name: "global query-key closures capturing tainted helper functions",
    path: "apps/web/src/lib/query/keys.ts",
    rule: "identity-scoped-query-keys",
    source:
      'const workspaceId = currentWorkspace.id;\nfunction scopedKey() { return ["global", workspaceId]; }\nexport const queryKeys = { global: { projects: () => scopedKey() } };',
  },
  {
    name: "global query-key closures capturing aliased auth imports",
    path: "apps/web/src/lib/query/keys.ts",
    rule: "identity-scoped-query-keys",
    source:
      'import { currentUser as principal } from "../auth/viewer";\nconst key = principal.id;\nexport const queryKeys = { global: { viewer: () => ["global", key] } };',
  },
  {
    name: "global query-key closures capturing destructured viewer ids",
    path: "apps/web/src/lib/query/keys.ts",
    rule: "identity-scoped-query-keys",
    source:
      'const viewer = getViewer();\nconst { id } = viewer;\nexport const queryKeys = { global: { viewer: () => ["global", id] } };',
  },
  {
    name: "global query-key closures capturing nested destructured workspace ids",
    path: "apps/web/src/lib/query/keys.ts",
    rule: "identity-scoped-query-keys",
    source:
      'const viewer = getViewer();\nconst { workspace: { id: workspaceId = "missing", ...workspaceRest } } = viewer;\nexport const queryKeys = { global: { viewer: () => ["global", workspaceId, workspaceRest] } };',
  },
  {
    name: "global query-key closures capturing destructured identity arrays",
    path: "apps/web/src/lib/query/keys.ts",
    rule: "identity-scoped-query-keys",
    source:
      'const sessions = currentSessions;\nconst [primary, ...remaining] = sessions;\nconst alias = primary;\nexport const queryKeys = { global: { sessions: () => ["global", alias, remaining] } };',
  },
  {
    name: "global query-key closures capturing destructured viewer parameters",
    path: "apps/web/src/lib/query/keys.ts",
    rule: "identity-scoped-query-keys",
    source:
      'export function createKeys({ workspace: { id: workspaceId = "missing" }, ...viewerRest }: Viewer) { return { global: { viewer: () => ["global", workspaceId, viewerRest] } }; }',
  },
  {
    name: "component-local V2 collection fetches",
    path: "apps/web/src/components/project-list.tsx",
    rule: "v2-fetch-ownership",
    source:
      'import { fetchProjectsPage } from "../lib/api/projects";\nexport function ProjectList() { return fetchProjectsPage(token, {}); }',
  },
  {
    name: "namespace component-local V2 collection fetches",
    path: "apps/web/src/components/project-list.tsx",
    rule: "v2-fetch-ownership",
    source:
      'import * as api from "../lib/api/projects";\nexport function ProjectList() { return api.fetchProjectsPage(token, {}); }',
  },
  {
    name: "re-exported component-local V2 collection fetches",
    path: "apps/web/src/components/project-list.tsx",
    rule: "v2-fetch-ownership",
    source:
      'import { projectsApi } from "../lib/domain-api";\nexport function ProjectList() { return projectsApi.fetchProjectsPage(token, {}); }',
  },
  {
    name: "direct domain V2 client calls from components",
    path: "apps/web/src/components/project-list.tsx",
    rule: "v2-fetch-ownership",
    source:
      'import { projectClient } from "../lib/api/projects";\nexport function ProjectList() { return projectClient.page(token, {}); }',
  },
  {
    name: "default-imported domain V2 clients",
    path: "apps/web/src/components/project-list.tsx",
    rule: "v2-fetch-ownership",
    source:
      'import projectClient from "../lib/api/projects";\nexport function ProjectList() { return projectClient.page(token, {}); }',
  },
  {
    name: "namespace destructured domain clients",
    path: "apps/web/src/components/project-list.tsx",
    rule: "v2-fetch-ownership",
    source:
      'import * as projects from "../lib/api/projects";\nconst { fetchProjectsPage } = projects;\nexport function ProjectList() { return fetchProjectsPage(token, {}); }',
  },
  {
    name: "namespace destructured aliased domain clients",
    path: "apps/web/src/components/project-list.tsx",
    rule: "v2-fetch-ownership",
    source:
      'import * as projects from "../lib/api/projects";\nconst { fetchProjectsPage: loadProjects } = projects;\nconst load = loadProjects;\nexport function ProjectList() { return load(token, {}); }',
  },
  {
    name: "direct global fetch calls to literal V2 paths",
    path: "apps/web/src/components/project-list.tsx",
    rule: "v2-fetch-ownership",
    source:
      'export function ProjectList() { return fetch("/api/v2/projects"); }',
  },
  {
    name: "direct apiFetch calls to template V2 paths",
    path: "apps/web/src/hooks/use-projects.ts",
    rule: "v2-fetch-ownership",
    source:
      "export function useProjects() { return apiFetch(`/api/v2/projects?workspace=${workspaceId}`); }",
  },
  {
    name: "direct request calls through constant V2 URLs",
    path: "apps/web/src/app/projects/page.tsx",
    rule: "v2-fetch-ownership",
    source:
      'const url = "/api/v2/projects";\nexport function Page() { return request(url); }',
  },
  {
    name: "aliased request calls through constant V2 URLs",
    path: "apps/web/src/components/project-list.tsx",
    rule: "v2-fetch-ownership",
    source:
      'const url = "/api/v2/projects";\nconst load = apiFetch;\nexport function ProjectList() { return load(url); }',
  },
  {
    name: "direct V2 requests from nonowner lib modules",
    path: "apps/web/src/lib/project-loader.ts",
    rule: "v2-fetch-ownership",
    source:
      'export function loadProjects() { return apiFetch("/api/v2/projects"); }',
  },
  {
    name: "direct V2 requests assembled with binary concatenation",
    path: "apps/web/src/components/project-list.tsx",
    rule: "v2-fetch-ownership",
    source:
      'const base = "/api/v2";\nconst projects = "/projects";\nexport function ProjectList() { return apiFetch(base + projects); }',
  },
  {
    name: "direct V2 requests assembled with template substitutions",
    path: "apps/web/src/components/project-list.tsx",
    rule: "v2-fetch-ownership",
    source:
      'const version = "v2";\nexport function ProjectList() { return apiFetch(`/api/${version}/projects`); }',
  },
  {
    name: "direct V2 requests through multi-level URL aliases",
    path: "apps/web/src/components/project-list.tsx",
    rule: "v2-fetch-ownership",
    source:
      'const endpoint = "/api/v2/projects";\nconst first = endpoint;\nconst second = first;\nexport function ProjectList() { return request(second); }',
  },
  {
    name: "unresolved direct API requests with static API fragments",
    path: "apps/web/src/components/project-list.tsx",
    rule: "v2-fetch-ownership",
    source:
      "const version = getVersion();\nexport function ProjectList() { return request(`/api/${version}/projects`); }",
  },
  {
    name: "unresolved component request URLs imported from constants",
    path: "apps/web/src/components/project-list.tsx",
    rule: "v2-fetch-ownership",
    source:
      'import { PROJECTS_URL } from "../config/routes";\nexport function ProjectList() { return fetch(PROJECTS_URL); }',
  },
  {
    name: "mutation retries without an idempotent-command allowlist",
    path: "apps/web/src/components/project-list.tsx",
    rule: "mutation-retry-policy",
    source: "useMutation({ mutationFn: createProject, retry: 2 });",
  },
  {
    name: "mutation retries inherited through config spread",
    path: "apps/web/src/components/project-list.tsx",
    rule: "mutation-retry-policy",
    source:
      "const base = { mutationFn: createProject };\nuseMutation({ ...base, retry: 2 });",
  },
  {
    name: "mutation retries through a lexical variable",
    path: "apps/web/src/components/project-list.tsx",
    rule: "mutation-retry-policy",
    source:
      "const retry = 2;\nuseMutation({ mutationFn: createProject, retry });",
  },
  {
    name: "nonfalse mutation defaults",
    path: "apps/web/src/lib/query/query-client.ts",
    rule: "mutation-retry-policy",
    source: "new QueryClient({ defaultOptions: { mutations: { retry: 2 } } });",
  },
  {
    name: "local allowlisted mutation command impersonation",
    path: "apps/web/src/components/attachment-retry.tsx",
    rule: "mutation-retry-policy",
    source:
      "const retryGeneratedAssetAttachment = async () => undefined;\nuseMutation({ mutationFn: retryGeneratedAssetAttachment, retry: 2 });",
  },
  {
    name: "renamed unrelated mutation command impersonation",
    path: "apps/web/src/components/attachment-retry.tsx",
    rule: "mutation-retry-policy",
    source:
      'import { deleteEverything as retryGeneratedAssetAttachment } from "../lib/unsafe";\nuseMutation({ mutationFn: retryGeneratedAssetAttachment, retry: 2 });',
  },
  {
    name: "unbounded collection services outside the route inventory",
    path: "apps/server/src/http/widgets.ts",
    rule: "collection-route-inventory",
    source:
      'export function register(app: FastifyInstance, service: WidgetService) { app.get("/api/widgets", async () => service.listWidgets()); }',
  },
  {
    name: "unbounded fetchAll collection services",
    path: "apps/server/src/http/widgets.ts",
    rule: "collection-route-inventory",
    source:
      'export function register(app: FastifyInstance, service: WidgetService) { app.get("/api/widgets", async () => service.fetchAllWidgets()); }',
  },
  {
    name: "direct Supabase collection selects",
    path: "apps/server/src/http/widgets.ts",
    rule: "collection-route-inventory",
    source:
      'export function register(app: FastifyInstance, client: SupabaseClient) { app.get("/api/widgets", async () => client.from("widgets").select("*")); }',
  },
  {
    name: "aliased collection service methods",
    path: "apps/server/src/http/widgets.ts",
    rule: "collection-route-inventory",
    source:
      'export function register(app: FastifyInstance, service: WidgetService) { const load = service.fetchAllWidgets; app.get("/api/widgets", async () => load()); }',
  },
  {
    name: "direct SQL query collection reads",
    path: "apps/server/src/http/widgets.ts",
    rule: "collection-route-inventory",
    source:
      'export function register(app: FastifyInstance, db: Database) { app.get("/api/widgets", async () => db.query("SELECT * FROM widgets")); }',
  },
  {
    name: "direct SQL execute collection reads through constants",
    path: "apps/server/src/http/widgets.ts",
    rule: "collection-route-inventory",
    source:
      'const sql = `SELECT id FROM widgets ORDER BY created_at`;\nexport function register(app: FastifyInstance, db: Database) { app.get("/api/widgets", async () => db.execute(sql)); }',
  },
  {
    name: "unknown GET routes without recognizable service names",
    path: "apps/server/src/http/widgets.ts",
    rule: "collection-route-inventory",
    source:
      'export function register(app: FastifyInstance, service: WidgetService) { app.get("/api/widgets", async () => service.load()); }',
  },
  {
    name: "unknown GET routes through constant paths",
    path: "apps/server/src/http/widgets.ts",
    rule: "collection-route-inventory",
    source:
      'const routePath = "/api/widgets";\nexport function register(app: FastifyInstance) { app.get(routePath, async () => []); }',
  },
  {
    name: "unknown app.route GET registrations",
    path: "apps/server/src/http/widgets.ts",
    rule: "collection-route-inventory",
    source:
      'const routePath = "/api/widgets";\nexport function register(app: FastifyInstance) { app.route({ method: "GET", url: routePath, handler: async () => [] }); }',
  },
  {
    name: "unknown app.route GET registrations through method arrays",
    path: "apps/server/src/http/widgets.ts",
    rule: "collection-route-inventory",
    source:
      'const methods = ["HEAD", "GET"];\nexport function register(app: FastifyInstance) { app.route({ method: methods, path: "/api/widgets", handler: async () => db.query("SELECT * FROM widgets") }); }',
  },
  {
    name: "dynamic GET route registrations",
    path: "apps/server/src/http/widgets.ts",
    rule: "collection-route-inventory",
    source:
      "export function register(app: FastifyInstance) { app.get(buildRoutePath(), async () => []); }",
  },
  {
    name: "unknown GET routes on named Fastify server parameters",
    path: "apps/server/src/http/widgets.ts",
    rule: "collection-route-inventory",
    source:
      'export function registerWidgetRoutes(server: FastifyInstance) { server.get("/api/widgets", async () => []); }',
  },
  {
    name: "unknown GET routes through Fastify receiver aliases",
    path: "apps/server/src/http/widgets.ts",
    rule: "collection-route-inventory",
    source:
      'export function registerWidgetRoutes(server: FastifyInstance) { const router = server; router.get("/api/widgets", async () => []); }',
  },
  {
    name: "unknown GET routes on constructed Fastify apps",
    path: "apps/server/src/http/widgets.ts",
    rule: "collection-route-inventory",
    source:
      'import Fastify from "fastify";\nconst server = Fastify();\nserver.route({ method: "GET", url: "/api/widgets", handler: async () => [] });',
  },
  {
    name: "unknown GET routes in typed Fastify plugins",
    path: "apps/server/src/http/widgets.ts",
    rule: "collection-route-inventory",
    source:
      'import type { FastifyPluginAsync as RoutePlugin } from "fastify";\nconst widgetRoutes: RoutePlugin<{ feature: string }> = async (server) => { server.get("/api/widgets", async () => []); };',
  },
  {
    name: "unknown GET routes in nested registered plugin aliases",
    path: "apps/server/src/http/widgets.ts",
    rule: "collection-route-inventory",
    source:
      'export function register(app: FastifyInstance) { const nested = async function (server) { const childPlugin = function (router) { router.get("/api/widgets", async () => []); }; server.register(childPlugin); }; const pluginAlias = nested; app.register(pluginAlias); }',
  },
];

for (const fixture of phase6AArchitectureFixtures) {
  test(`phase 6A architecture boundary rejects ${fixture.name}`, () => {
    const findings = scanPhase6AArchitectureSources([fixture]);
    assert.equal(findings.length, 1, fixture.name);
    assert.equal(findings[0].rule, fixture.rule, fixture.name);
    assert.match(findings[0].evidence, new RegExp(`^${fixture.path}:`));
  });
}

test("phase 6A query factory provenance accepts authoritative imports only", () => {
  const positiveSources = [
    {
      path: "apps/web/src/lib/query/keys.ts",
      source:
        'export const queryKeys = { global: { health: () => ["health"] }, workspace: { projects: () => ["projects"] } };',
    },
    {
      path: "apps/web/src/lib/query/index.ts",
      source: 'export { queryKeys as keys } from "./keys";',
    },
    {
      path: "apps/web/src/components/direct.tsx",
      source:
        'import { queryKeys } from "../lib/query/keys";\nuseQuery({ queryKey: queryKeys.workspace.projects() });',
    },
    {
      path: "apps/web/src/components/alias.tsx",
      source:
        'import { queryKeys as keys } from "../lib/query/keys";\nuseQuery({ queryKey: keys.workspace.projects() });',
    },
    {
      path: "apps/web/src/components/namespace.tsx",
      source:
        'import * as keyModule from "../lib/query/keys";\nuseQuery({ queryKey: keyModule.queryKeys.workspace.projects() });',
    },
    {
      path: "apps/web/src/components/reexport.tsx",
      source:
        'import { keys } from "../lib/query";\nuseQuery({ queryKey: keys.workspace.projects() });',
    },
    {
      path: "apps/web/src/components/global.tsx",
      source:
        'import { queryKeys } from "../lib/query/keys";\nuseQuery({ queryKey: queryKeys.global.health() });',
    },
  ];

  assert.deepEqual(scanPhase6AArchitectureSources(positiveSources), []);

  const forgedReexport = scanPhase6AArchitectureSources([
    {
      path: "apps/web/src/lib/query/facade.ts",
      source: 'export { queryKeys as keys } from "../not-query-keys";',
    },
    {
      path: "apps/web/src/components/forged-reexport.tsx",
      source:
        'import { keys } from "../lib/query/facade";\nuseQuery({ queryKey: keys.workspace.projects() });',
    },
  ]);
  assert.equal(forgedReexport[0]?.rule, "query-key-factory-boundary");
});

test("phase 6A lexical resolution respects shadowing and declaration order", () => {
  const authoritativeKeys = 'import { queryKeys } from "../lib/query/keys";\n';
  const cases = [
    {
      name: "later authoritative key cannot cover earlier raw key",
      source: `${authoritativeKeys}function earlier() { const key = ["raw"]; useQuery({ queryKey: key }); }\nfunction later() { const key = queryKeys.workspace.projects(); useQuery({ queryKey: key }); }`,
      rule: "query-key-factory-boundary",
    },
    {
      name: "earlier authoritative key cannot hide later raw key",
      source: `${authoritativeKeys}function earlier() { const key = queryKeys.workspace.projects(); useQuery({ queryKey: key }); }\nfunction later() { const key = ["raw"]; useQuery({ queryKey: key }); }`,
      rule: "query-key-factory-boundary",
    },
    {
      name: "later health URL cannot cover earlier V2 URL",
      source:
        'function earlier() { const url = "/api/v2/projects"; fetch(url); }\nfunction later() { const url = "/api/health"; fetch(url); }',
      rule: "v2-fetch-ownership",
    },
    {
      name: "earlier health URL cannot hide later V2 URL",
      source:
        'function earlier() { const url = "/api/health"; fetch(url); }\nfunction later() { const url = "/api/v2/projects"; fetch(url); }',
      rule: "v2-fetch-ownership",
    },
    {
      name: "parameter shadowing blocks imported queryKeys provenance",
      source: `${authoritativeKeys}function Component(queryKeys: LocalKeys) { useQuery({ queryKey: queryKeys.workspace.projects() }); }`,
      rule: "query-key-factory-boundary",
    },
  ];
  for (const entry of cases) {
    const findings = scanPhase6AArchitectureSources([
      {
        path: "apps/web/src/components/lexical.tsx",
        source: entry.source,
      },
    ]);
    assert.equal(findings.length, 1, entry.name);
    assert.equal(findings[0]?.rule, entry.rule, entry.name);
  }

  assert.deepEqual(
    scanPhase6AArchitectureSources([
      {
        path: "apps/web/src/components/lexical-positive.tsx",
        source: `${authoritativeKeys}function keys() { const value = queryKeys.workspace.projects(); useQuery({ queryKey: value }); }\nfunction health() { const value = "/api/health"; fetch(value); }`,
      },
    ]),
    [],
  );
});

test("phase 6A import provenance does not cross lexical shadows", () => {
  const shadowedSources = [
    {
      path: "apps/web/src/components/domain-shadow.tsx",
      source:
        'import * as api from "../lib/api/projects";\nfunction Component(api: LocalApi) { return api.load(); }',
    },
    {
      path: "apps/server/src/http/fastify-shadow.ts",
      source:
        'import Fastify from "fastify";\nfunction build(Fastify: LocalFactory) { const local = Fastify(); local.get("/api/widgets"); }',
    },
  ];
  assert.deepEqual(scanPhase6AArchitectureSources(shadowedSources), []);

  const domainFindings = scanPhase6AArchitectureSources([
    {
      path: "apps/web/src/components/domain-import.tsx",
      source:
        'import * as api from "../lib/api/projects";\nexport function Component() { return api.load(); }',
    },
  ]);
  assert.equal(domainFindings[0]?.rule, "v2-fetch-ownership");

  const fastifySources = [
    {
      path: "apps/server/src/http/imported-fastify.ts",
      source:
        'import Fastify from "fastify";\nconst app = Fastify();\napp.get("/api/widgets", async () => []);',
    },
  ];
  assert.deepEqual(
    phase6ABoundaries
      .discoverPhase6AGetRoutes(fastifySources)
      .map(({ path }) => path),
    ["/api/widgets"],
  );
  assert.ok(
    scanPhase6AArchitectureSources(fastifySources).some(
      ({ rule }) => rule === "collection-route-inventory",
    ),
  );
});

test("phase 6A global keys allow fixed deployment constants", () => {
  const findings = scanPhase6AArchitectureSources([
    {
      path: "apps/web/src/lib/query/keys.ts",
      source:
        'const DEPLOYMENT_REGION = "cn-east";\nconst API_REVISION = "2026-08";\nfunction deploymentKey() { return ["health", DEPLOYMENT_REGION, API_REVISION]; }\nexport const queryKeys = { global: { health: () => deploymentKey() } };',
    },
  ]);
  assert.deepEqual(findings, []);
});

test("phase 6A route discovery handles existing constant and app.route forms", () => {
  const sources = [
    {
      path: "apps/server/src/http/health.ts",
      source:
        'const healthPath = "/api/health";\nexport function register(app: FastifyInstance) { app.get(healthPath, async () => ({ ok: true })); }',
    },
    {
      path: "apps/server/src/http/viewer.ts",
      source:
        'const method = ["HEAD", "GET"];\nconst viewerPath = "/api/viewer";\nexport function register(app: FastifyInstance) { app.route({ method, url: viewerPath, handler: async () => ({}) }); }',
    },
  ];
  assert.deepEqual(
    phase6ABoundaries
      .discoverPhase6AGetRoutes(sources)
      .map(({ path }) => path)
      .sort(),
    ["/api/health", "/api/viewer"],
  );
  assert.deepEqual(scanPhase6AArchitectureSources(sources), []);
});

test("phase 6A ownership gates retain valid non-V2 and owner patterns", () => {
  const sources = [
    {
      path: "apps/web/src/components/status.tsx",
      source: 'export function Status() { return fetch("/api/health"); }',
    },
    {
      path: "apps/web/src/lib/api/projects.ts",
      source:
        'import { PROJECTS_URL } from "../../config/routes";\nexport function load() { return apiFetch(PROJECTS_URL); }',
    },
    {
      path: "apps/server/src/http/cache.ts",
      source:
        'const cache = { get: (key: string) => key };\ncache.get("widget");',
    },
    {
      path: "apps/server/src/http/local-fastify-name.ts",
      source:
        'function Fastify() { return { get: (key: string) => key }; }\nconst local = Fastify();\nlocal.get("widget");',
    },
  ];
  assert.deepEqual(scanPhase6AArchitectureSources(sources), []);
});

test("phase 6A Fastify contextual provenance retains classified and ordinary callbacks", () => {
  const sources = [
    {
      path: "apps/server/src/http/health-plugin.ts",
      source:
        'import type { FastifyPluginCallback as HealthPlugin } from "fastify";\nconst healthRoutes: HealthPlugin = function (server, _options, done) { server.get("/api/health", async () => ({ ok: true })); done(); };',
    },
    {
      path: "apps/server/src/http/ordinary-register.ts",
      source:
        'const registry = { register(callback: (service: Service) => void) { callback(service); } };\nregistry.register((service) => service.get("widget"));',
    },
  ];
  assert.deepEqual(scanPhase6AArchitectureSources(sources), []);
  assert.deepEqual(
    phase6ABoundaries.discoverPhase6AGetRoutes(sources).map(({ path }) => path),
    ["/api/health"],
  );
});

test("phase 6A mutation retry allowlist accepts only proven exports", () => {
  assert.deepEqual(phase6ABoundaries.phase6AIdempotentMutationRetryAllowlist, [
    {
      modulePath: "apps/web/src/lib/server-api.ts",
      exportName: "retryGeneratedAssetAttachment",
    },
  ]);
  const allowed = scanPhase6AArchitectureSources([
    {
      path: "apps/web/src/components/attachment-retry.tsx",
      source:
        'import { retryGeneratedAssetAttachment } from "../lib/server-api";\nuseMutation({ mutationFn: retryGeneratedAssetAttachment, retry: 2 });',
    },
    {
      path: "apps/web/src/components/attachment-retry-alias.tsx",
      source:
        'import { retryGeneratedAssetAttachment as retryAttachment } from "../lib/server-api";\nuseMutation({ mutationFn: retryAttachment, retry: 2 });',
    },
    {
      path: "apps/web/src/components/attachment-retry-namespace.tsx",
      source:
        'import * as api from "../lib/server-api";\nuseMutation({ mutationFn: api.retryGeneratedAssetAttachment, retry: 2 });',
    },
    {
      path: "apps/web/src/lib/retry-commands.ts",
      source:
        'export { retryGeneratedAssetAttachment as retryAttachment } from "./server-api";',
    },
    {
      path: "apps/web/src/components/attachment-retry-reexport.tsx",
      source:
        'import { retryAttachment } from "../lib/retry-commands";\nuseMutation({ mutationFn: retryAttachment, retry: 2 });',
    },
  ]);
  const unknown = scanPhase6AArchitectureSources([
    {
      path: "apps/web/src/components/attachment-retry.tsx",
      source: "useMutation({ mutationFn: unknownCommand, retry: 2 });",
    },
  ]);

  assert.deepEqual(allowed, []);
  assert.equal(unknown[0]?.rule, "mutation-retry-policy");
});

test("phase 6A mutation retry diagnostics fail closed without crashing", () => {
  const findings = scanPhase6AArchitectureSources([
    {
      path: "apps/web/src/components/mutations.tsx",
      source:
        'import { useMutation } from "@tanstack/react-query";\nuseMutation({ retry: 2 });\nuseMutation({ mutationFn: unresolvedCommand, retry: 3 });\nfetch("/api/v2/projects");',
    },
  ]);
  assert.deepEqual(
    findings.map(({ rule }) => rule),
    ["mutation-retry-policy", "mutation-retry-policy", "v2-fetch-ownership"],
  );
});

test("phase 6A collection inventory is unique, classified, and evidence-backed", () => {
  const inventory = phase6ABoundaries.phase6ACollectionRouteInventory;
  assert.equal(inventory.length, 16);
  const paths = inventory.map(({ path }) => path);
  assert.equal(new Set(paths).size, paths.length, "duplicate inventory path");
  for (const entry of inventory) {
    assert.ok(
      ["cursor", "bounded", "legacy-gap"].includes(entry.classification),
      `${entry.path} has an invalid classification`,
    );
    assert.equal(typeof entry.implementationEvidence, "string", entry.path);
    assert.ok(entry.implementationEvidence.length > 0, entry.path);
    if (entry.classification === "bounded") {
      assert.equal(typeof entry.cap, "number", `${entry.path} needs a cap`);
      assert.ok(entry.cap > 0, `${entry.path} cap must be positive`);
      assert.equal(typeof entry.capContract?.ownerFile, "string", entry.path);
      assert.equal(typeof entry.capContract?.ownerExport, "string", entry.path);
      assert.equal(typeof entry.capContract?.method, "string", entry.path);
      assert.ok(
        [
          "awaited-query-call",
          "call-argument-property",
          "exported-function-response-slice",
        ].includes(entry.capContract?.kind),
        entry.path,
      );
      if (entry.capContract.kind === "awaited-query-call") {
        assert.equal(
          typeof entry.capContract.queryVariable,
          "string",
          entry.path,
        );
        assert.equal(typeof entry.capContract.member, "string", entry.path);
      } else if (entry.capContract.kind === "call-argument-property") {
        assert.equal(typeof entry.capContract.calleeRoot, "string", entry.path);
        assert.equal(
          typeof entry.capContract.calleeMethod,
          "string",
          entry.path,
        );
        assert.equal(
          typeof entry.capContract.argumentIndex,
          "number",
          entry.path,
        );
        assert.equal(typeof entry.capContract.property, "string", entry.path);
      }
      if (entry.capContract.kind === "exported-function-response-slice") {
        assert.equal(
          typeof entry.capContract.capIdentifier,
          "string",
          entry.path,
        );
      }
    }
  }
});

test("phase 6A GET inventory classifies every route without changing collection totals", () => {
  const inventory = phase6ABoundaries.phase6AGetRouteInventory;
  assert.equal(inventory.length, 29);
  const paths = inventory.map(({ path }) => path);
  assert.equal(
    new Set(paths).size,
    paths.length,
    "duplicate GET inventory path",
  );
  assert.equal(
    inventory.filter(({ classification }) => classification !== "singleton")
      .length,
    16,
  );
  for (const entry of inventory) {
    assert.ok(
      ["singleton", "cursor", "bounded", "legacy-gap"].includes(
        entry.classification,
      ),
      `${entry.path} has an invalid GET classification`,
    );
    assert.ok(entry.implementationEvidence.length > 0, entry.path);
  }
});

test("phase 6A collection inventory matches every registered collection GET", async () => {
  const sources = await collectPhase6AArchitectureSources(rootDir);
  assert.deepEqual(
    phase6ABoundaries.auditPhase6ACollectionRouteInventory(sources),
    [],
  );
});

test("phase 6A bounded evidence rejects unrelated same-value decoys", async () => {
  const sources = await collectPhase6AArchitectureSources(rootDir);
  const cases = [
    {
      path: "apps/server/src/features/jobs/job-service.ts",
      actual: ".limit(50);",
      replacement: ";",
      decoy: "const unrelatedJobLimit = query.limit(50);",
      route: "/api/jobs",
    },
    {
      path: "apps/server/src/features/canvas/generated-asset-application-adapter.ts",
      actual: "limit: 100,",
      replacement: "",
      decoy: "const unrelatedAttachmentOptions = { limit: 100 };",
      route: "/api/canvases/:canvasId/generated-asset-attachments",
    },
  ];
  for (const entry of cases) {
    const mutated = sources.map((source) =>
      source.path === entry.path
        ? {
            ...source,
            source: `${source.source.replace(entry.actual, entry.replacement)}\n${entry.decoy}`,
          }
        : source,
    );
    const issues =
      phase6ABoundaries.auditPhase6ACollectionRouteInventory(mutated);
    assert.ok(
      issues.some((issue) => issue.includes(`${entry.route} cap`)),
      `${entry.route} accepted an unrelated cap decoy`,
    );
  }
});

test("phase 6A bounded evidence follows the actual capped flow", async () => {
  const sources = await collectPhase6AArchitectureSources(rootDir);
  const cases = [
    {
      path: "apps/server/src/features/jobs/job-service.ts",
      mutate(source) {
        return source
          .replace(".limit(50);", ".limit(runtimeLimit);")
          .replace(
            "      const { data: jobs, error } = await query;",
            "      const runtimeLimit = 25;\n      query.limit(50);\n      const { data: jobs, error } = await query;",
          );
      },
      route: "/api/jobs",
    },
    {
      path: "apps/server/src/features/canvas/generated-asset-application-adapter.ts",
      mutate(source) {
        return source
          .replace("        limit: 100,", "        limit: runtimeLimit,")
          .replace(
            "    listOutstanding(principal, command) {",
            "    listOutstanding(principal, command) {\n      const runtimeLimit = 25;\n      const decoy = { nested: { limit: 100 } };",
          );
      },
      route: "/api/canvases/:canvasId/generated-asset-attachments",
    },
  ];
  const rejectedRoutes = [];
  for (const entry of cases) {
    const mutated = sources.map((source) =>
      source.path === entry.path
        ? { ...source, source: entry.mutate(source.source) }
        : source,
    );
    const issues =
      phase6ABoundaries.auditPhase6ACollectionRouteInventory(mutated);
    if (issues.some((issue) => issue.includes(`${entry.route} cap`))) {
      rejectedRoutes.push(entry.route);
    }
  }
  assert.deepEqual(
    rejectedRoutes,
    cases.map(({ route }) => route),
  );
});

test("phase 6A jobs cap evidence follows one lexical query binding", async () => {
  const sources = await collectPhase6AArchitectureSources(rootDir);
  const jobPath = "apps/server/src/features/jobs/job-service.ts";
  const actualDeclaration = "      let query = client";
  const dynamicActual = ".limit(runtimeLimit);";
  const cases = [
    {
      name: "nested uncalled function",
      decoy:
        '      function decoy() { let query = client.from("background_jobs").select("id").limit(50); return query; }\n',
    },
    {
      name: "outer block shadow",
      decoy:
        '      { let query = client.from("background_jobs").select("id").limit(50); void query; }\n',
    },
  ];
  const rejectedCases = [];
  for (const entry of cases) {
    const mutated = sources.map((source) =>
      source.path === jobPath
        ? {
            ...source,
            source: source.source
              .replace(".limit(50);", dynamicActual)
              .replace(
                actualDeclaration,
                `      const runtimeLimit = 25;\n${entry.decoy}${actualDeclaration}`,
              ),
          }
        : source,
    );
    const issues =
      phase6ABoundaries.auditPhase6ACollectionRouteInventory(mutated);
    if (issues.some((issue) => issue.includes("/api/jobs cap"))) {
      rejectedCases.push(entry.name);
    }
  }
  assert.deepEqual(
    rejectedCases,
    cases.map(({ name }) => name),
  );

  const positive = sources.map((source) =>
    source.path === jobPath
      ? {
          ...source,
          source: source.source.replace(
            actualDeclaration,
            '      function decoy() { let query = client.from("background_jobs").select("id").limit(runtimeLimit); return query; }\n      { let query = client.from("background_jobs").select("id").limit(runtimeLimit); void query; }\n      const runtimeLimit = 25;\n      let query = client',
          ),
        }
      : source,
  );
  assert.ok(
    !phase6ABoundaries
      .auditPhase6ACollectionRouteInventory(positive)
      .some((issue) => issue.includes("/api/jobs cap")),
    "the capped outer jobs query was rejected",
  );
});

test("phase 6A lexical shadows include uninitialized variable declarations", async () => {
  const sources = await collectPhase6AArchitectureSources(rootDir);
  const jobPath = "apps/server/src/features/jobs/job-service.ts";
  const mutated = sources.map((source) =>
    source.path === jobPath
      ? {
          ...source,
          source: source.source
            .replace(".limit(50);", ".limit(runtimeLimit);")
            .replace(
              "      let query = client",
              "      const runtimeLimit = 25;\n      { let query; query = unrelated.limit(50); void query; }\n      let query = client",
            ),
        }
      : source,
  );
  assert.ok(
    phase6ABoundaries
      .auditPhase6ACollectionRouteInventory(mutated)
      .some((issue) => issue.includes("/api/jobs cap")),
    "an uninitialized block shadow proved the outer jobs cap",
  );

  assert.deepEqual(
    scanPhase6AArchitectureSources([
      {
        path: "apps/web/src/components/uninitialized.tsx",
        source:
          "export function Component() { let pending; pending = 1; return pending; }",
      },
    ]),
    [],
  );
});

test("phase 6A verification derives collection counts from the scanner inventory", async () => {
  const verification = await readText("docs/tech/phase-6a-verification.md");
  assert.match(
    verification,
    new RegExp(
      `Inventory source: ${phase6ABoundaries.phase6ACollectionInventorySummary.replaceAll(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&",
      )}`,
    ),
  );
});

test("phase 6A server-state and collection boundaries remain enforced", async () => {
  const sources = await collectPhase6AArchitectureSources(rootDir);
  const findings = scanPhase6AArchitectureSources(sources);

  assert.deepEqual(
    findings,
    [],
    findings.map(({ evidence, message }) => `${evidence}${message}`).join("\n"),
  );
});

test("Agent run listener ownership remains canvas-scoped", async () => {
  const [canvasPage, chatSidebar, controller] = await Promise.all([
    readText("apps/web/src/app/canvas/page.tsx"),
    readText("apps/web/src/components/chat-sidebar.tsx"),
    readText("apps/web/src/lib/agent-run-controller.ts"),
  ]);

  assert.match(canvasPage, /createAgentRunController\s*\(/);
  assert.doesNotMatch(
    canvasPage,
    /useMemo\s*\([\s\S]{0,300}createAgentRunController\s*\(/,
  );
  assert.match(canvasPage, /runController=\{runController\}/);
  assert.match(canvasPage, /chatOpen\s*\?\s*\([\s\S]*<ChatSidebar/);
  assert.match(canvasPage, /onPersistenceFailure:/);
  assert.match(canvasPage, /onRecoveredPersistenceFailure:/);
  assert.match(canvasPage, /runController\.requestResume\s*\(\s*\)/);
  assert.match(canvasPage, /onReplayGap:[\s\S]*invalidateQueries\s*\(/);
  assert.doesNotMatch(chatSidebar, /runListenerByRunIdRef/);
  assert.doesNotMatch(chatSidebar, /assistantIdByRunIdRef/);
  assert.doesNotMatch(chatSidebar, /ws\.onEvent\s*\(/);
  assert.doesNotMatch(chatSidebar, /ws\.resumeCanvas\s*\(/);
  assert.doesNotMatch(
    chatSidebar,
    /useMemo\s*\([\s\S]{0,300}createAgentRunController\s*\(/,
  );
  assert.doesNotMatch(chatSidebar, /runController\.requestResume\s*\(/);
  assert.doesNotMatch(chatSidebar, /runController\.onEvent\s*\(/);
  assert.doesNotMatch(chatSidebar, /setPersistenceHandlers/);
  assert.equal(
    controller.match(/options\.ws\.onEvent\s*\(/g)?.length,
    1,
    "controller must own exactly one underlying WebSocket subscription",
  );
});
