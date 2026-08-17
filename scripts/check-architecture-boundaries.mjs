import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const serverSource = "apps/server/src";

const rules = [
  {
    id: "instance-owned-registries",
    message:
      "provider and executor registries must be instance-owned and composed explicitly",
    pathPattern:
      /^apps\/server\/src\/(?:app|worker|generation\/providers\/(?:registry|register-all)|features\/jobs\/(?:job-executor|executors\/register-all))\.ts$/,
    scanner: scanTopLevelRegistries,
  },
  {
    id: "shared-zod-boundary",
    message:
      "HTTP routes must delegate Zod recognition to the shared request/error boundary",
    pathPrefix: `${serverSource}/http/`,
    excludePaths: new Set([`${serverSource}/http/error-handler.ts`]),
    patterns: [
      /\b(?:function|const)\s+isZodError\b/g,
      /\berror\s*(?:as\s+[^;\n]+)?\.issues\b/g,
      /["']issues["']\s+in\s+error\b/g,
      /\berror\s*\.\s*name\s*===\s*["']ZodError["']/g,
    ],
  },
  {
    id: "schema-aware-web-api",
    message:
      "server-api must use apiFetch and validate responses with shared schemas",
    paths: new Set(["apps/web/src/lib/server-api.ts"]),
    patterns: [
      /\bfetch\s*\(/g,
      /\.json\s*\(/g,
      /\bresponse\s+as\s+(?:unknown\s+as\s+)?[A-Z][\w<>{}\[\]|, ]*/g,
    ],
  },
  {
    id: "generation-use-case-boundary",
    message:
      "migrated adapters must orchestrate queued generation through SubmitGeneration/CancelGeneration",
    paths: new Set([
      `${serverSource}/agent/runtime.ts`,
      `${serverSource}/http/generate.ts`,
      `${serverSource}/http/jobs.ts`,
    ]),
    patterns: [
      /\.(?:createJob|cancelJob|setCreditsInfo)\s*\(/g,
      /\bjobService\.(?:enqueue|submit)\w*\s*\(/g,
    ],
  },
  {
    id: "skill-import-use-case-boundary",
    message:
      "HTTP Skill imports must go through the ImportSkill application use case",
    paths: new Set([`${serverSource}/http/skills.ts`]),
    patterns: [/\bimportSkillFromUrl\b/g],
  },
  {
    id: "canvas-application-boundary",
    message:
      "Agent canvas writes and generated-media insertion must use application boundaries",
    pathPrefix: `${serverSource}/agent/`,
    patterns: [
      /\.from\(\s*["']canvases["']\s*\)[\s\S]{0,300}?\.(?:delete|insert|update|upsert)\s*\(/g,
      /\.from\(\s*["'](?:assets|project_assets)["']\s*\)[\s\S]{0,300}?\.insert\s*\(/g,
      /\b(?:insertGeneratedMediaElement|persistGeneratedMedia|writeCanvasContent)\s*\(/g,
    ],
  },
];

function normalizePath(filePath) {
  return filePath.replaceAll("\\", "/");
}

function applies(rule, filePath) {
  if (rule.excludePaths?.has(filePath)) return false;
  return (
    rule.paths?.has(filePath) ||
    rule.pathPattern?.test(filePath) ||
    (rule.pathPrefix && filePath.startsWith(rule.pathPrefix))
  );
}

function lineNumberAt(source, index) {
  return source.slice(0, index).split("\n").length;
}

export function scanArchitectureSources(sources) {
  const findings = [];

  for (const entry of sources) {
    const filePath = normalizePath(entry.path);
    if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(filePath)) continue;

    for (const rule of rules) {
      if (!applies(rule, filePath)) continue;
      for (const finding of rule.scanner?.(entry.source, filePath) ?? []) {
        findings.push({ ...finding, message: rule.message, rule: rule.id });
      }
      for (const pattern of rule.patterns ?? []) {
        for (const match of entry.source.matchAll(pattern)) {
          const line = lineNumberAt(entry.source, match.index ?? 0);
          const excerpt = match[0].split("\n", 1)[0].trim().slice(0, 120);
          findings.push({
            evidence: `${filePath}:${line} ${excerpt} - `,
            message: rule.message,
            rule: rule.id,
          });
        }
      }
    }
  }

  return findings.sort((left, right) =>
    left.evidence.localeCompare(right.evidence),
  );
}

function scanTopLevelRegistries(source, filePath) {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const findings = [];

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      const initializer = unwrapExpression(declaration.initializer);
      if (!initializer || !ts.isNewExpression(initializer)) continue;

      const constructorName = initializer.expression.getText(sourceFile);
      const isRegistry = /^(?:Provider|Executor)Registry$/.test(
        constructorName,
      );
      const isSemanticMap =
        constructorName === "Map" &&
        /(?:provider|executor|registr|catalog)/i.test(declaration.name.text);
      if (!isRegistry && !isSemanticMap) continue;

      const start = declaration.getStart(sourceFile);
      const { line } = sourceFile.getLineAndCharacterOfPosition(start);
      findings.push({
        evidence: `${filePath}:${line + 1} ${declaration
          .getText(sourceFile)
          .split("\n", 1)[0]
          .trim()
          .slice(0, 120)} - `,
      });
    }
  }

  return findings;
}

function unwrapExpression(expression) {
  let current = expression;
  while (
    current &&
    (ts.isAsExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isTypeAssertionExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

export async function collectArchitectureSources(rootDir) {
  const targets = [
    ...(await productionTypeScriptFiles(rootDir, serverSource)),
    "apps/web/src/lib/server-api.ts",
  ].sort();

  return Promise.all(
    targets.map(async (relativePath) => ({
      path: relativePath,
      source: await readFile(path.join(rootDir, relativePath), "utf8"),
    })),
  );
}

async function productionTypeScriptFiles(rootDir, relativeDirectory) {
  const directory = path.join(rootDir, relativeDirectory);
  const targets = [];

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) {
      targets.push(...(await productionTypeScriptFiles(rootDir, relativePath)));
    } else if (
      entry.name.endsWith(".ts") &&
      !/\.(?:test|spec)\.ts$/.test(entry.name)
    ) {
      targets.push(relativePath);
    }
  }

  return targets;
}
