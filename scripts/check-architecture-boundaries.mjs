import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const serverSource = "apps/server/src";
const canvasWriteMethods = new Set(["delete", "insert", "update", "upsert"]);
const generatedMediaTables = new Set(["assets", "project_assets"]);
const registryValueShapeWrappers = new Set([
  "Array",
  "NonNullable",
  "Partial",
  "Readonly",
  "ReadonlyArray",
  "Required",
]);

const phase6ACollectionRouteInventory = new Map([
  ["/api/v2/projects", "cursor-paginated"],
  ["/api/v2/brand-kits", "cursor-paginated"],
  ["/api/v2/credits/transactions", "cursor-paginated"],
  ["/api/v2/canvases/:canvasId/sessions", "cursor-paginated"],
  ["/api/v2/sessions/:sessionId/messages", "cursor-paginated"],
  ["/api/projects", "legacy-compatibility-removal-window"],
  ["/api/brand-kits", "legacy-compatibility-removal-window"],
  ["/api/credits/transactions", "legacy-compatibility-removal-window"],
  ["/api/canvases/:canvasId/sessions", "legacy-compatibility-removal-window"],
  ["/api/sessions/:sessionId/messages", "legacy-compatibility-removal-window"],
  ["/api/jobs", "intrinsically-bounded-service-limit"],
  [
    "/api/canvases/:canvasId/generated-asset-attachments",
    "intrinsically-bounded-outstanding-only",
  ],
  ["/api/fonts", "intrinsically-bounded-upstream-catalog"],
  ["/api/models", "intrinsically-bounded-static-catalog"],
  ["/api/image-models", "intrinsically-bounded-provider-catalog"],
  ["/api/video-models", "intrinsically-bounded-provider-catalog"],
]);

const rules = [
  {
    id: "instance-owned-registries",
    message:
      "provider and executor registries must be instance-owned and composed explicitly",
    pathPrefix: `${serverSource}/`,
    scanner: scanTopLevelRegistries,
  },
  {
    id: "shared-zod-boundary",
    message:
      "HTTP routes must delegate Zod recognition to the shared request/error boundary",
    pathPrefix: `${serverSource}/http/`,
    excludePaths: new Set([`${serverSource}/http/error-handler.ts`]),
    scanner: scanRouteLocalZodChecks,
  },
  {
    id: "schema-aware-web-api",
    message:
      "server-api must use apiFetch and validate responses with shared schemas",
    paths: new Set(["apps/web/src/lib/server-api.ts"]),
    scanner: scanWebApiCalls,
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
    scanner: scanGenerationOrchestration,
  },
  {
    id: "skill-import-use-case-boundary",
    message:
      "HTTP Skill imports must go through the ImportSkill application use case",
    paths: new Set([`${serverSource}/http/skills.ts`]),
    scanner: scanDirectSkillImporter,
  },
  {
    id: "canvas-application-boundary",
    message:
      "Agent canvas writes and generated-media insertion must use application boundaries",
    pathPrefix: `${serverSource}/agent/`,
    scanner: scanAgentCanvasWrites,
  },
  {
    id: "phase2-persistence-boundary",
    message:
      "job transitions, Canvas content, and compensation must use Phase 2 repositories",
    pathPrefix: `${serverSource}/`,
    excludePaths: new Set([
      `${serverSource}/features/jobs/job-state-repository.ts`,
      `${serverSource}/features/canvas/canvas-repository.ts`,
      `${serverSource}/features/credits/credit-service.ts`,
    ]),
    scanner: scanPhase2PersistenceBypasses,
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

export function scanArchitectureSources(sources) {
  const findings = [];

  for (const entry of sources) {
    const filePath = normalizePath(entry.path);
    if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(filePath)) continue;
    const sourceFile = parseSourceFile(entry.source, filePath);
    const context = { filePath, sourceFile };

    for (const rule of rules) {
      if (!applies(rule, filePath)) continue;
      for (const finding of rule.scanner(context)) {
        findings.push({ ...finding, message: rule.message, rule: rule.id });
      }
    }
  }

  return findings.sort((left, right) =>
    left.evidence.localeCompare(right.evidence),
  );
}

export function scanPhase6AArchitectureSources(sources) {
  const findings = [];
  for (const entry of sources) {
    const filePath = normalizePath(entry.path);
    if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(filePath)) continue;
    const sourceFile = parseSourceFile(entry.source, filePath);
    const context = { filePath, sourceFile };
    findings.push(...scanRawQueryKeys(context));
    findings.push(...scanIdentityScopedKeys(context));
    findings.push(...scanComponentV2Fetches(context));
    findings.push(...scanMutationRetries(context));
    findings.push(...scanCollectionRoutes(context));
  }
  return findings.sort((left, right) =>
    left.evidence.localeCompare(right.evidence),
  );
}

function phase6AFinding(rule, message, node, context) {
  return { ...findingAt(node, context), rule, message };
}

function scanRawQueryKeys(context) {
  if (context.filePath === "apps/web/src/lib/query/keys.ts") return [];
  return collectMatchingNodes(context, (node) => {
    if (
      !ts.isPropertyAssignment(node) ||
      propertyName(node.name) !== "queryKey"
    )
      return false;
    return ts.isArrayLiteralExpression(unwrapExpression(node.initializer));
  }).map((finding) => ({
    ...finding,
    rule: "query-key-factory-boundary",
    message: "query keys must be created by apps/web/src/lib/query/keys.ts",
  }));
}

function scanIdentityScopedKeys(context) {
  if (context.filePath !== "apps/web/src/lib/query/keys.ts") return [];
  const findings = [];
  function visit(node) {
    if (
      ts.isPropertyAssignment(node) &&
      propertyName(node.name) === "global" &&
      containsIdentityDerivedKey(node.initializer)
    ) {
      findings.push(
        phase6AFinding(
          "identity-scoped-query-keys",
          "identity-derived resources cannot live below a global query-key namespace",
          node,
          context,
        ),
      );
    }
    ts.forEachChild(node, visit);
  }
  visit(context.sourceFile);
  return findings;
}

function containsIdentityDerivedKey(node) {
  let found = false;
  function visit(current) {
    if (
      ts.isIdentifier(current) &&
      /^(?:userId|workspaceId|canvasId|sessionId|ownerId)$/.test(current.text)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return found;
}

function scanComponentV2Fetches(context) {
  if (!/^apps\/web\/src\/(?:app|components|hooks)\//.test(context.filePath))
    return [];
  const v2Bindings = new Set();
  for (const statement of context.sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const moduleName = statement.moduleSpecifier;
    if (!ts.isStringLiteral(moduleName) || !/lib\/api\//.test(moduleName.text))
      continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const imported = (element.propertyName ?? element.name).text;
      if (/^fetch\w+Page$/.test(imported)) v2Bindings.add(element.name.text);
    }
  }
  return collectMatchingNodes(
    context,
    (node) =>
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      v2Bindings.has(node.expression.text),
  ).map((finding) => ({
    ...finding,
    rule: "v2-fetch-ownership",
    message: "V2 collection fetches must be owned by the shared query layer",
  }));
}

function scanMutationRetries(context) {
  if (!context.filePath.startsWith("apps/web/src/")) return [];
  const findings = [];
  function visit(node) {
    if (ts.isObjectLiteralExpression(node)) {
      const hasMutationFn = node.properties.some(
        (property) => propertyName(property.name) === "mutationFn",
      );
      const retry = node.properties.find(
        (property) => propertyName(property.name) === "retry",
      );
      if (
        hasMutationFn &&
        retry &&
        ts.isPropertyAssignment(retry) &&
        retry.initializer.kind !== ts.SyntaxKind.FalseKeyword
      ) {
        findings.push(
          phase6AFinding(
            "mutation-retry-policy",
            "mutation retry requires an explicitly allowlisted idempotent command",
            retry,
            context,
          ),
        );
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(context.sourceFile);
  return findings;
}

function scanCollectionRoutes(context) {
  if (!context.filePath.startsWith("apps/server/src/http/")) return [];
  const findings = [];
  function visit(node) {
    if (
      !ts.isCallExpression(node) ||
      !ts.isPropertyAccessExpression(node.expression)
    ) {
      ts.forEachChild(node, visit);
      return;
    }
    if (node.expression.name.text !== "get") {
      ts.forEachChild(node, visit);
      return;
    }
    const routeArgument = node.arguments.find(ts.isStringLiteral);
    const handler = node.arguments.at(-1);
    if (
      routeArgument &&
      handler &&
      containsCollectionServiceCall(handler) &&
      !phase6ACollectionRouteInventory.has(routeArgument.text)
    ) {
      findings.push(
        phase6AFinding(
          "collection-route-inventory",
          "collection routes must be cursor-paginated or inventoried with an intrinsic bound",
          routeArgument,
          context,
        ),
      );
    }
    ts.forEachChild(node, visit);
  }
  visit(context.sourceFile);
  return findings;
}

function containsCollectionServiceCall(node) {
  let found = false;
  function visit(current) {
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      /^(?:list|getAvailable)\w+/.test(current.expression.name.text)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return found;
}

function propertyName(name) {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

function parseSourceFile(source, filePath) {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const diagnostic = sourceFile.parseDiagnostics?.[0];
  if (diagnostic) {
    const { line } = sourceFile.getLineAndCharacterOfPosition(
      diagnostic.start ?? 0,
    );
    throw new Error(
      `${filePath}:${line + 1} architecture scan rejected invalid TypeScript syntax`,
    );
  }
  return sourceFile;
}

function scanPhase2PersistenceBypasses({ filePath, sourceFile }) {
  const findings = [];
  visit(sourceFile);
  return findings;

  function visit(node) {
    if (ts.isCallExpression(node)) {
      const text = node.getText(sourceFile);
      const directJobUpdate =
        /\.from\(\s*["']background_jobs["']\s*\)[\s\S]*?\.update\s*\(/.test(
          text,
        );
      const directCanvasUpdate =
        /\.from\(\s*["']canvases["']\s*\)[\s\S]*?\.update\s*\(\s*\{[\s\S]*?\bcontent\s*:/.test(
          text,
        );
      const lifecycleCompensation =
        /(?:refundCredits|refund_credits|compensateGeneration)\s*\(/.test(
          text,
        ) && /(?:worker|jobs|generation)/.test(filePath);
      if (directJobUpdate || directCanvasUpdate || lifecycleCompensation) {
        findings.push(findingAt(node, { filePath, sourceFile }));
      }
    }
    ts.forEachChild(node, visit);
  }
}

function scanTopLevelRegistries({ filePath, sourceFile }) {
  const findings = [];
  const imports = registryImportBindings(sourceFile);

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      const initializer = unwrapExpression(declaration.initializer);
      const isRegistryType = isRegistryTypeNode(declaration.type, imports);
      const isRegistryConstruction =
        initializer &&
        ts.isNewExpression(initializer) &&
        resolveRegistrySymbol(initializer.expression, imports) !== undefined;
      const isRegistryFactory =
        initializer &&
        ts.isCallExpression(initializer) &&
        resolveRegistryFactory(initializer.expression, imports) !== undefined;
      const isSemanticMap =
        initializer &&
        ts.isNewExpression(initializer) &&
        ts.isIdentifier(initializer.expression) &&
        initializer.expression.text === "Map" &&
        /(?:provider|executor|registr|catalog)/i.test(declaration.name.text);
      if (
        !isRegistryType &&
        !isRegistryConstruction &&
        !isRegistryFactory &&
        !isSemanticMap
      ) {
        continue;
      }

      findings.push(findingAt(declaration, { filePath, sourceFile }));
    }
  }

  return findings;
}

function registryImportBindings(sourceFile) {
  const named = new Map();
  const namespaces = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const importedName = (element.propertyName ?? element.name).text;
        if (isKnownRegistrySymbol(importedName)) {
          named.set(element.name.text, importedName);
        }
      }
    } else if (bindings && ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
    }
  }
  return { named, namespaces };
}

function resolveRegistrySymbol(expression, imports) {
  if (ts.isIdentifier(expression)) {
    if (isKnownRegistryType(expression.text)) {
      return expression.text;
    }
    const imported = imports.named.get(expression.text);
    return isKnownRegistryType(imported) ? imported : undefined;
  }
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    imports.namespaces.has(expression.expression.text) &&
    isKnownRegistryType(expression.name.text)
  ) {
    return expression.name.text;
  }
  return undefined;
}

function resolveRegistryFactory(expression, imports) {
  if (ts.isIdentifier(expression)) {
    if (isKnownRegistryFactory(expression.text)) return expression.text;
    const imported = imports.named.get(expression.text);
    return isKnownRegistryFactory(imported) ? imported : undefined;
  }
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    imports.namespaces.has(expression.expression.text) &&
    isKnownRegistryFactory(expression.name.text)
  ) {
    return expression.name.text;
  }
  return undefined;
}

function isRegistryTypeNode(typeNode, imports) {
  if (!typeNode) return false;
  if (ts.isTypeReferenceNode(typeNode)) {
    const isValueShapeWrapper =
      ts.isIdentifier(typeNode.typeName) &&
      registryValueShapeWrappers.has(typeNode.typeName.text);
    return (
      isRegistryTypeName(typeNode.typeName, imports) ||
      (isValueShapeWrapper &&
        (typeNode.typeArguments?.some((typeArgument) =>
          isRegistryTypeNode(typeArgument, imports),
        ) ??
          false))
    );
  }
  if (ts.isUnionTypeNode(typeNode) || ts.isIntersectionTypeNode(typeNode)) {
    return typeNode.types.some((member) => isRegistryTypeNode(member, imports));
  }
  if (ts.isParenthesizedTypeNode(typeNode)) {
    return isRegistryTypeNode(typeNode.type, imports);
  }
  if (ts.isArrayTypeNode(typeNode)) {
    return isRegistryTypeNode(typeNode.elementType, imports);
  }
  if (ts.isTypeOperatorNode(typeNode)) {
    return isRegistryTypeNode(typeNode.type, imports);
  }
  return false;
}

function isRegistryTypeName(name, imports) {
  if (ts.isIdentifier(name)) {
    if (isKnownRegistryType(name.text)) return true;
    return isKnownRegistryType(imports.named.get(name.text));
  }
  return (
    ts.isQualifiedName(name) &&
    ts.isIdentifier(name.left) &&
    imports.namespaces.has(name.left.text) &&
    isKnownRegistryType(name.right.text)
  );
}

function isKnownRegistrySymbol(name) {
  return isKnownRegistryType(name) || isKnownRegistryFactory(name);
}

function isKnownRegistryType(name) {
  return /^(?:Provider|Executor)Registry$/.test(name ?? "");
}

function isKnownRegistryFactory(name) {
  return /^(?:registerAllProviders|registerAllExecutors)$/.test(name ?? "");
}

function scanRouteLocalZodChecks(context) {
  return collectMatchingNodes(context, (node) => {
    if (
      (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "isZodError"
    ) {
      return true;
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === "issues") {
      return isIdentifier(unwrapExpression(node.expression), "error");
    }
    if (ts.isBinaryExpression(node)) {
      if (
        node.operatorToken.kind === ts.SyntaxKind.InKeyword &&
        ts.isStringLiteral(node.left) &&
        node.left.text === "issues" &&
        isIdentifier(unwrapExpression(node.right), "error")
      ) {
        return true;
      }
      if (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) {
        return isErrorNameAndZodError(node.left, node.right);
      }
    }
    return false;
  });
}

function isErrorNameAndZodError(left, right) {
  return (
    ts.isPropertyAccessExpression(left) &&
    left.name.text === "name" &&
    isIdentifier(unwrapExpression(left.expression), "error") &&
    ts.isStringLiteral(right) &&
    right.text === "ZodError"
  );
}

function scanWebApiCalls(context) {
  return collectMatchingNodes(context, (node) => {
    if (ts.isCallExpression(node)) {
      if (isIdentifier(node.expression, "fetch")) return true;
      return (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "json"
      );
    }
    return (
      ts.isAsExpression(node) &&
      !ts.isAsExpression(node.parent) &&
      isIdentifier(unwrapExpression(node.expression), "response")
    );
  });
}

function scanGenerationOrchestration(context) {
  const directMethods = new Set(["createJob", "cancelJob", "setCreditsInfo"]);
  return collectMatchingNodes(context, (node) => {
    if (!ts.isCallExpression(node)) return false;
    const callee = node.expression;
    if (!ts.isPropertyAccessExpression(callee)) return false;
    if (directMethods.has(callee.name.text)) return true;
    return (
      isIdentifier(unwrapExpression(callee.expression), "jobService") &&
      /^(?:enqueue|submit)/.test(callee.name.text)
    );
  });
}

function scanDirectSkillImporter(context) {
  return collectMatchingNodes(context, (node) => {
    if (ts.isImportSpecifier(node)) {
      return (node.propertyName ?? node.name).text === "importSkillFromUrl";
    }
    return (
      ts.isCallExpression(node) &&
      (isIdentifier(node.expression, "importSkillFromUrl") ||
        (ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "importSkillFromUrl"))
    );
  });
}

function scanAgentCanvasWrites(context) {
  const legacyWriters = new Set([
    "insertGeneratedMediaElement",
    "persistGeneratedMedia",
    "writeCanvasContent",
  ]);
  return collectMatchingNodes(context, (node) => {
    if (!ts.isCallExpression(node)) return false;
    if (ts.isIdentifier(node.expression)) {
      return legacyWriters.has(node.expression.text);
    }
    if (!ts.isPropertyAccessExpression(node.expression)) return false;
    const method = node.expression.name.text;
    if (legacyWriters.has(method)) return true;
    const table = findSupabaseTable(node.expression.expression);
    return (
      (table === "canvases" && canvasWriteMethods.has(method)) ||
      (generatedMediaTables.has(table) && method === "insert")
    );
  });
}

function findSupabaseTable(expression) {
  const current = unwrapExpression(expression);
  if (!current) return undefined;
  if (ts.isCallExpression(current)) {
    if (
      ts.isPropertyAccessExpression(current.expression) &&
      current.expression.name.text === "from" &&
      current.arguments[0] &&
      ts.isStringLiteral(current.arguments[0])
    ) {
      return current.arguments[0].text;
    }
    return findSupabaseTable(current.expression);
  }
  if (ts.isPropertyAccessExpression(current)) {
    return findSupabaseTable(current.expression);
  }
  return undefined;
}

function collectMatchingNodes(context, predicate) {
  const findings = [];
  function visit(node) {
    if (predicate(node)) findings.push(findingAt(node, context));
    ts.forEachChild(node, visit);
  }
  visit(context.sourceFile);
  return findings;
}

function findingAt(node, { filePath, sourceFile }) {
  const start = node.getStart(sourceFile);
  const { line } = sourceFile.getLineAndCharacterOfPosition(start);
  return {
    evidence: `${filePath}:${line + 1} ${node
      .getText(sourceFile)
      .split("\n", 1)[0]
      .trim()
      .slice(0, 120)} - `,
  };
}

function isIdentifier(node, name) {
  return node !== undefined && ts.isIdentifier(node) && node.text === name;
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

export async function collectPhase6AArchitectureSources(rootDir) {
  const targets = [
    ...(await productionTypeScriptFiles(rootDir, "apps/web/src")),
    ...(await productionTypeScriptFiles(rootDir, "apps/server/src/http")),
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
