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

export const phase6AIdempotentMutationRetryAllowlist = Object.freeze([
  Object.freeze({
    modulePath: "apps/web/src/lib/server-api.ts",
    exportName: "retryGeneratedAssetAttachment",
  }),
]);

export const phase6ACollectionRouteInventory = Object.freeze([
  cursorRoute("/api/v2/projects", "apps/server/src/http/projects.ts"),
  cursorRoute("/api/v2/brand-kits", "apps/server/src/http/brand-kits.ts"),
  cursorRoute(
    "/api/v2/credits/transactions",
    "apps/server/src/http/credits.ts",
  ),
  cursorRoute(
    "/api/v2/canvases/:canvasId/sessions",
    "apps/server/src/http/chat.ts",
  ),
  cursorRoute(
    "/api/v2/sessions/:sessionId/messages",
    "apps/server/src/http/chat.ts",
  ),
  gapRoute("/api/projects", "apps/server/src/http/projects.ts"),
  gapRoute("/api/brand-kits", "apps/server/src/http/brand-kits.ts"),
  gapRoute("/api/credits/transactions", "apps/server/src/http/credits.ts"),
  gapRoute("/api/canvases/:canvasId/sessions", "apps/server/src/http/chat.ts"),
  gapRoute("/api/sessions/:sessionId/messages", "apps/server/src/http/chat.ts"),
  boundedRoute(
    "/api/jobs",
    "apps/server/src/http/jobs.ts",
    50,
    "apps/server/src/features/jobs/job-service.ts#call:limit",
  ),
  boundedRoute(
    "/api/canvases/:canvasId/generated-asset-attachments",
    "apps/server/src/http/jobs.ts",
    100,
    "apps/server/src/features/canvas/generated-asset-application-adapter.ts#property:limit",
  ),
  gapRoute("/api/fonts", "apps/server/src/http/fonts.ts"),
  gapRoute("/api/models", "apps/server/src/http/models.ts"),
  gapRoute("/api/image-models", "apps/server/src/http/image-models.ts"),
  gapRoute("/api/video-models", "apps/server/src/http/video-models.ts"),
]);

export const phase6ACollectionInventorySummary = Object.freeze(
  ["cursor", "bounded", "legacy-gap"]
    .map(
      (classification) =>
        `${classification}=${
          phase6ACollectionRouteInventory.filter(
            (entry) => entry.classification === classification,
          ).length
        }`,
    )
    .concat(`total=${phase6ACollectionRouteInventory.length}`)
    .join(", "),
);

export const phase6AGetRouteInventory = Object.freeze([
  ...phase6ACollectionRouteInventory,
  singletonRoute(
    "/api/brand-kits/:kitId",
    "apps/server/src/http/brand-kits.ts",
    "resource lookup by kitId",
  ),
  singletonRoute(
    "/api/credits",
    "apps/server/src/http/credits.ts",
    "authenticated workspace balance",
  ),
  singletonRoute(
    "/api/health",
    "apps/server/src/http/health.ts",
    "process health snapshot",
  ),
  singletonRoute(
    "/api/health/realtime",
    "apps/server/src/http/health.ts",
    "realtime dependency health snapshot",
  ),
  singletonRoute(
    "/api/jobs/:jobId",
    "apps/server/src/http/jobs.ts",
    "resource lookup by jobId",
  ),
  singletonRoute(
    "/api/jobs/:jobId/attachment",
    "apps/server/src/http/jobs.ts",
    "single attachment lookup for one job",
  ),
  singletonRoute(
    "/api/payments/subscription",
    "apps/server/src/http/payments.ts",
    "authenticated workspace subscription",
  ),
  singletonRoute(
    "/api/projects/:projectId",
    "apps/server/src/http/projects.ts",
    "resource lookup by projectId",
  ),
  singletonRoute(
    "/api/workspace/settings",
    "apps/server/src/http/settings.ts",
    "authenticated workspace settings",
  ),
  singletonRoute(
    "/api/viewer",
    "apps/server/src/http/viewer.ts",
    "authenticated viewer identity",
  ),
  singletonRoute(
    "/api/canvases/:canvasId",
    "apps/server/src/http/canvases.ts",
    "resource lookup by canvasId",
  ),
  singletonRoute(
    "/api/uploads/:assetId/url",
    "apps/server/src/http/uploads.ts",
    "single signed URL lookup by assetId",
  ),
  singletonRoute(
    "/api/proxy-image",
    "apps/server/src/http/image-proxy.ts",
    "single upstream image proxy response",
  ),
]);

const phase6ACollectionRoutesByPath = new Map(
  phase6ACollectionRouteInventory.map((entry) => [entry.path, entry]),
);
const phase6AGetRoutesByPath = new Map(
  phase6AGetRouteInventory.map((entry) => [entry.path, entry]),
);

function cursorRoute(pathname, file) {
  return Object.freeze({
    path: pathname,
    file,
    classification: "cursor",
    implementationEvidence: `${file}#paginationQuerySchema+Page`,
  });
}

function boundedRoute(pathname, file, cap, implementationEvidence) {
  return Object.freeze({
    path: pathname,
    file,
    classification: "bounded",
    cap,
    implementationEvidence,
  });
}

function gapRoute(pathname, file) {
  return Object.freeze({
    path: pathname,
    file,
    classification: "legacy-gap",
    implementationEvidence: `${file}#unbounded-compatibility-or-catalog-gap`,
  });
}

function singletonRoute(pathname, file, rationale) {
  return Object.freeze({
    path: pathname,
    file,
    classification: "singleton",
    implementationEvidence: rationale,
  });
}

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
    const context = createPhase6AContext(filePath, sourceFile);

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
  const sourceGraph = createSourceGraph(sources);
  for (const entry of sources) {
    const filePath = normalizePath(entry.path);
    if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(filePath)) continue;
    const sourceFile = parseSourceFile(entry.source, filePath);
    const context = createPhase6AContext(filePath, sourceFile, sourceGraph);
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
    return !isProvenQueryFactoryExpression(node.initializer, context);
  }).map((finding) => ({
    ...finding,
    rule: "query-key-factory-boundary",
    message: "query keys must be created by apps/web/src/lib/query/keys.ts",
  }));
}

function isProvenQueryFactoryExpression(expression, context, seen = new Set()) {
  const current = unwrapExpression(expression);
  if (!current) return false;
  if (ts.isIdentifier(current) && context.bindings.has(current.text)) {
    if (seen.has(current.text)) return false;
    seen.add(current.text);
    return isProvenQueryFactoryExpression(
      context.bindings.get(current.text),
      context,
      seen,
    );
  }
  if (ts.isIdentifier(current)) {
    return isProvenQueryKeyParameter(current, context, seen);
  }
  if (ts.isConditionalExpression(current)) {
    return (
      isProvenQueryFactoryExpression(
        current.whenTrue,
        context,
        new Set(seen),
      ) &&
      isProvenQueryFactoryExpression(current.whenFalse, context, new Set(seen))
    );
  }
  if (ts.isCallExpression(current)) {
    if (
      isCallNamed(current.expression, "useMemo") &&
      current.arguments[0] &&
      (ts.isArrowFunction(current.arguments[0]) ||
        ts.isFunctionExpression(current.arguments[0]))
    ) {
      return isProvenQueryFactoryOrNull(
        current.arguments[0].body,
        context,
        seen,
      );
    }
    return isAuthoritativeQueryKeyAccess(current.expression, context);
  }
  if (ts.isPropertyAccessExpression(current)) {
    return isAuthoritativeQueryKeyAccess(current, context);
  }
  return false;
}

function isAuthoritativeQueryKeyAccess(expression, context) {
  const access = rootAccess(expression);
  if (!access) return false;
  const origin = resolveImportOrigin(access.root, access.members, context);
  return (
    origin?.modulePath === "apps/web/src/lib/query/keys.ts" &&
    origin.exportName === "queryKeys"
  );
}

function isProvenQueryFactoryOrNull(expression, context, seen) {
  const current = unwrapExpression(expression);
  if (current?.kind === ts.SyntaxKind.NullKeyword) return true;
  if (current && ts.isConditionalExpression(current)) {
    return (
      isProvenQueryFactoryOrNull(current.whenTrue, context, new Set(seen)) &&
      isProvenQueryFactoryOrNull(current.whenFalse, context, new Set(seen))
    );
  }
  return isProvenQueryFactoryExpression(current, context, seen);
}

function isProvenQueryKeyParameter(identifier, context, seen) {
  const owner = findContainingFunction(identifier);
  if (!owner) return false;
  const parameterIndex = owner.parameters.findIndex(
    (parameter) =>
      ts.isIdentifier(parameter.name) &&
      parameter.name.text === identifier.text,
  );
  if (parameterIndex < 0) return false;
  const callbackCall = owner.parent;
  const declaration = callbackCall?.parent;
  if (
    !callbackCall ||
    !ts.isCallExpression(callbackCall) ||
    !declaration ||
    !ts.isVariableDeclaration(declaration) ||
    !ts.isIdentifier(declaration.name)
  )
    return false;
  const argumentsAtCalls = [];
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === declaration.name.text
    ) {
      argumentsAtCalls.push(node.arguments[parameterIndex]);
    }
    ts.forEachChild(node, visit);
  }
  visit(context.sourceFile);
  return (
    argumentsAtCalls.length > 0 &&
    argumentsAtCalls.every((argument) =>
      isProvenQueryFactoryExpression(argument, context, new Set(seen)),
    )
  );
}

function findContainingFunction(node) {
  let current = node.parent;
  while (current) {
    if (
      ts.isArrowFunction(current) ||
      ts.isFunctionExpression(current) ||
      ts.isFunctionDeclaration(current)
    )
      return current;
    current = current.parent;
  }
  return undefined;
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
      (ts.isArrowFunction(current) ||
        ts.isFunctionExpression(current) ||
        ts.isFunctionDeclaration(current)) &&
      current.parameters.length > 0
    ) {
      found = true;
      return;
    }
    if (ts.isCallExpression(current) && current.arguments.length > 0) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return found;
}

function scanComponentV2Fetches(context) {
  if (!context.filePath.startsWith("apps/web/src/")) return [];
  if (
    context.filePath.startsWith("apps/web/src/lib/api/") ||
    context.filePath.startsWith("apps/web/src/lib/query/") ||
    context.filePath === "apps/web/src/lib/api-client.ts" ||
    context.filePath === "apps/web/src/lib/server-api.ts"
  )
    return [];
  const domainBindings = new Set();
  for (const statement of context.sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const moduleName = statement.moduleSpecifier;
    if (!ts.isStringLiteral(moduleName) || !isDomainApiModule(moduleName.text))
      continue;
    const bindings = statement.importClause?.namedBindings;
    const defaultBinding = statement.importClause?.name;
    if (defaultBinding) domainBindings.add(defaultBinding.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements)
        domainBindings.add(element.name.text);
    } else if (bindings && ts.isNamespaceImport(bindings)) {
      domainBindings.add(bindings.name.text);
    }
  }
  return collectMatchingNodes(
    context,
    (node) =>
      ts.isCallExpression(node) &&
      ((callRootIdentifier(node.expression) !== undefined &&
        domainBindings.has(callRootIdentifier(node.expression))) ||
        isDirectV2Request(node, context)),
  ).map((finding) => ({
    ...finding,
    rule: "v2-fetch-ownership",
    message: "V2 collection fetches must be owned by the shared query layer",
  }));
}

function isDirectV2Request(call, context) {
  const callee = resolveExpression(call.expression, context);
  if (!ts.isIdentifier(callee)) return false;
  if (!/^(?:fetch|apiFetch|request)$/.test(callee.text)) return false;
  const url = staticStringValue(call.arguments[0], context);
  return url?.includes("/api/v2/") ?? false;
}

function staticStringValue(expression, context) {
  const current = resolveExpression(expression, context);
  if (
    ts.isStringLiteral(current) ||
    ts.isNoSubstitutionTemplateLiteral(current)
  )
    return current.text;
  if (ts.isTemplateExpression(current)) {
    return `${current.head.text}${current.templateSpans
      .map((span) => `${span.literal.text}`)
      .join("")}`;
  }
  return undefined;
}

function isDomainApiModule(moduleName) {
  const parts = moduleName.replaceAll("\\", "/").split("/");
  const libIndex = parts.lastIndexOf("lib");
  return (
    libIndex >= 0 &&
    (parts[libIndex + 1] === "api" || parts[libIndex + 1] === "domain-api")
  );
}

function callRootIdentifier(expression) {
  let current = unwrapExpression(expression);
  while (ts.isPropertyAccessExpression(current)) current = current.expression;
  return ts.isIdentifier(current) ? current.text : undefined;
}

function scanMutationRetries(context) {
  if (!context.filePath.startsWith("apps/web/src/")) return [];
  const findings = [];
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      isCallNamed(node.expression, "useMutation")
    ) {
      inspectMutationOptions(node.arguments[0], node);
    }
    if (
      ts.isNewExpression(node) &&
      isCallNamed(node.expression, "QueryClient")
    ) {
      const root = resolveObjectProperties(node.arguments?.[0], context);
      const defaults = resolveObjectProperties(
        root.values.get("defaultOptions"),
        context,
      );
      const mutations = resolveObjectProperties(
        defaults.values.get("mutations"),
        context,
      );
      inspectRetry(mutations, node, undefined);
    }
    ts.forEachChild(node, visit);
  }
  visit(context.sourceFile);
  return findings;

  function inspectMutationOptions(expression, evidenceNode) {
    const options = resolveObjectProperties(expression, context);
    const mutationFn = options.values.get("mutationFn");
    inspectRetry(
      options,
      evidenceNode,
      resolveCommandOrigin(mutationFn, context),
    );
  }

  function inspectRetry(options, evidenceNode, commandOrigin) {
    if (!options.values.has("retry") && !options.unresolved) return;
    const retry = resolveExpression(options.values.get("retry"), context);
    const staticallyFalse = retry?.kind === ts.SyntaxKind.FalseKeyword;
    const allowlisted =
      commandOrigin !== undefined &&
      phase6AIdempotentMutationRetryAllowlist.some(
        (entry) =>
          entry.modulePath === commandOrigin.modulePath &&
          entry.exportName === commandOrigin.exportName,
      );
    if (!staticallyFalse && !allowlisted) {
      findings.push(
        phase6AFinding(
          "mutation-retry-policy",
          "mutation retry is nonfalse or unresolved; use false or an explicitly allowlisted idempotent command",
          evidenceNode,
          context,
        ),
      );
    }
  }
}

function resolveCommandOrigin(expression, context) {
  const resolved = resolveExpression(expression, context);
  const access = rootAccess(resolved);
  if (!access) return undefined;
  return resolveImportOrigin(access.root, access.members, context);
}

function isCallNamed(expression, name) {
  const current = unwrapExpression(expression);
  return (
    (ts.isIdentifier(current) && current.text === name) ||
    (ts.isPropertyAccessExpression(current) && current.name.text === name)
  );
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
      !phase6AGetRoutesByPath.has(routeArgument.text)
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
      isCollectionAccessCall(current, contextForNode(node))
    ) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return found;
}

function contextForNode(node) {
  const sourceFile = node.getSourceFile();
  return createPhase6AContext(sourceFile.fileName, sourceFile);
}

function isCollectionAccessCall(call, context) {
  const callee = resolveExpression(call.expression, context);
  if (ts.isPropertyAccessExpression(callee)) {
    const name = callee.name.text;
    if (
      name.startsWith("list") ||
      name.startsWith("fetchAll") ||
      name.startsWith("getAvailable")
    )
      return true;
    if (name === "select" && findCallInChain(callee.expression, "from"))
      return true;
  }
  return false;
}

function findCallInChain(node, methodName) {
  let current = unwrapExpression(node);
  while (current) {
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      current.expression.name.text === methodName
    )
      return true;
    if (ts.isCallExpression(current)) current = current.expression;
    else if (ts.isPropertyAccessExpression(current))
      current = current.expression;
    else return false;
  }
  return false;
}

function createSourceGraph(sources) {
  return new Map(
    sources.map((entry) => {
      const filePath = normalizePath(entry.path);
      return [filePath, parseSourceFile(entry.source, filePath)];
    }),
  );
}

function createPhase6AContext(filePath, sourceFile, sourceGraph) {
  const bindings = new Map();
  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      bindings.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return { filePath, sourceFile, bindings, sourceGraph };
}

function rootAccess(expression) {
  let current = unwrapExpression(expression);
  const members = [];
  while (ts.isPropertyAccessExpression(current)) {
    members.unshift(current.name.text);
    current = unwrapExpression(current.expression);
  }
  return ts.isIdentifier(current) ? { root: current.text, members } : undefined;
}

function resolveImportOrigin(localName, members, context) {
  for (const statement of context.sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const moduleSpecifier = statement.moduleSpecifier;
    if (!ts.isStringLiteral(moduleSpecifier)) continue;
    const modulePath = resolveModulePath(
      context.filePath,
      moduleSpecifier.text,
      context.sourceGraph,
    );
    const importClause = statement.importClause;
    if (importClause?.name?.text === localName) {
      return resolveExportOrigin(modulePath, "default", context.sourceGraph);
    }
    const bindings = importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      const element = bindings.elements.find(
        (candidate) => candidate.name.text === localName,
      );
      if (element) {
        const exportName = element.propertyName?.text ?? element.name.text;
        return resolveExportOrigin(modulePath, exportName, context.sourceGraph);
      }
    }
    if (
      bindings &&
      ts.isNamespaceImport(bindings) &&
      bindings.name.text === localName
    ) {
      const [exportName] = members;
      if (!exportName) return undefined;
      return resolveExportOrigin(modulePath, exportName, context.sourceGraph);
    }
  }
  return undefined;
}

function resolveExportOrigin(
  modulePath,
  exportName,
  sourceGraph,
  seen = new Set(),
) {
  const key = `${modulePath}#${exportName}`;
  if (seen.has(key)) return undefined;
  seen.add(key);
  const sourceFile = sourceGraph?.get(modulePath);
  if (!sourceFile) return { modulePath, exportName };
  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.exportClause) continue;
    if (!ts.isNamedExports(statement.exportClause)) continue;
    const element = statement.exportClause.elements.find(
      (candidate) => candidate.name.text === exportName,
    );
    if (!element) continue;
    const sourceName = element.propertyName?.text ?? element.name.text;
    if (
      !statement.moduleSpecifier ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      return { modulePath, exportName: sourceName };
    }
    const sourcePath = resolveModulePath(
      modulePath,
      statement.moduleSpecifier.text,
      sourceGraph,
    );
    return resolveExportOrigin(sourcePath, sourceName, sourceGraph, seen);
  }
  return { modulePath, exportName };
}

function resolveModulePath(importerPath, moduleSpecifier, sourceGraph) {
  let base;
  if (moduleSpecifier.startsWith("@/")) {
    base = `apps/web/src/${moduleSpecifier.slice(2)}`;
  } else if (moduleSpecifier.startsWith(".")) {
    base = normalizePath(
      path.posix.join(path.posix.dirname(importerPath), moduleSpecifier),
    );
  } else {
    return moduleSpecifier;
  }
  const withoutJs = base.replace(/\.(?:js|jsx|mjs|cjs)$/, "");
  const candidates = [
    base,
    `${withoutJs}.ts`,
    `${withoutJs}.tsx`,
    `${withoutJs}/index.ts`,
    `${withoutJs}/index.tsx`,
  ];
  return (
    candidates.find((candidate) => sourceGraph?.has(candidate)) ??
    `${withoutJs}.ts`
  );
}

function resolveExpression(expression, context, seen = new Set()) {
  let current = unwrapExpression(expression);
  while (
    current &&
    ts.isIdentifier(current) &&
    context.bindings.has(current.text)
  ) {
    if (seen.has(current.text)) return current;
    seen.add(current.text);
    current = unwrapExpression(context.bindings.get(current.text));
  }
  return current;
}

function resolveObjectProperties(expression, context, seen = new Set()) {
  const resolved = resolveExpression(expression, context, seen);
  const values = new Map();
  let unresolved = false;
  if (!resolved || !ts.isObjectLiteralExpression(resolved)) {
    return { values, unresolved: expression !== undefined };
  }
  for (const property of resolved.properties) {
    if (ts.isSpreadAssignment(property)) {
      const spread = resolveObjectProperties(
        property.expression,
        context,
        seen,
      );
      for (const [key, value] of spread.values) values.set(key, value);
      unresolved ||= spread.unresolved;
      continue;
    }
    const name = propertyName(property.name);
    if (!name) {
      unresolved = true;
      continue;
    }
    if (ts.isPropertyAssignment(property))
      values.set(name, property.initializer);
    else if (ts.isShorthandPropertyAssignment(property))
      values.set(name, property.name);
    else unresolved = true;
  }
  return { values, unresolved };
}

function propertyName(name) {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

export function auditPhase6ACollectionRouteInventory(sources) {
  const issues = [];
  const sourceByPath = new Map(
    sources.map((entry) => [normalizePath(entry.path), entry.source]),
  );
  const registered = [];
  const discoveredCollections = new Set();

  for (const entry of sources) {
    const filePath = normalizePath(entry.path);
    if (!filePath.startsWith("apps/server/src/http/")) continue;
    const sourceFile = parseSourceFile(entry.source, filePath);
    const context = createPhase6AContext(filePath, sourceFile);
    for (const route of registeredGetRoutes(context)) {
      registered.push({ ...route, filePath });
      if (containsCollectionServiceCall(route.handler)) {
        discoveredCollections.add(route.path);
      }
    }
  }

  const duplicates = duplicateValues(
    phase6AGetRouteInventory.map((entry) => entry.path),
  );
  for (const pathname of duplicates)
    issues.push(`duplicate inventory path: ${pathname}`);

  for (const inventoryEntry of phase6AGetRouteInventory) {
    const route = registered.find(
      (candidate) =>
        candidate.path === inventoryEntry.path &&
        candidate.filePath === inventoryEntry.file,
    );
    if (!route) {
      issues.push(
        `${inventoryEntry.path} is not registered in ${inventoryEntry.file}`,
      );
      continue;
    }
    if (
      inventoryEntry.classification === "cursor" &&
      !isCursorCollectionHandler(route.handler)
    ) {
      issues.push(
        `${inventoryEntry.path} lacks paginationQuerySchema + Page evidence`,
      );
    }
    if (inventoryEntry.classification === "bounded") {
      const evidenceIssue = verifyBoundedEvidence(inventoryEntry, sourceByPath);
      if (evidenceIssue) issues.push(evidenceIssue);
    }
  }

  for (const pathname of discoveredCollections) {
    if (!phase6ACollectionRoutesByPath.has(pathname)) {
      issues.push(`${pathname} is a collection GET missing from the inventory`);
    }
  }
  for (const route of registered) {
    if (!phase6AGetRoutesByPath.has(route.path)) {
      issues.push(`${route.path} is a GET route missing from the inventory`);
    }
  }
  return issues.sort();
}

function registeredGetRoutes(context) {
  const routes = [];
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "get"
    ) {
      const routeArgument = node.arguments.find(ts.isStringLiteral);
      const handler = node.arguments.at(-1);
      if (routeArgument && handler) {
        routes.push({ path: routeArgument.text, handler });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(context.sourceFile);
  return routes;
}

function isCursorCollectionHandler(handler) {
  let hasSchema = false;
  let hasPageCall = false;
  function visit(node) {
    if (ts.isIdentifier(node) && node.text === "paginationQuerySchema") {
      hasSchema = true;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text.endsWith("Page")
    ) {
      hasPageCall = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(handler);
  return hasSchema && hasPageCall;
}

function verifyBoundedEvidence(entry, sourceByPath) {
  const [filePath, evidence] = entry.implementationEvidence.split("#");
  const source = sourceByPath.get(filePath);
  if (!source) return `${entry.path} evidence source is missing: ${filePath}`;
  const sourceFile = parseSourceFile(source, filePath);
  const [kind, name] = evidence.split(":");
  let matched = false;
  function visit(node) {
    if (
      kind === "call" &&
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === name &&
      numericLiteralValue(node.arguments[0]) === entry.cap
    ) {
      matched = true;
    }
    if (
      kind === "property" &&
      ts.isPropertyAssignment(node) &&
      propertyName(node.name) === name &&
      numericLiteralValue(node.initializer) === entry.cap
    ) {
      matched = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return matched
    ? undefined
    : `${entry.path} cap ${entry.cap} is not proven by ${entry.implementationEvidence}`;
}

function numericLiteralValue(node) {
  const current = unwrapExpression(node);
  return current && ts.isNumericLiteral(current)
    ? Number(current.text)
    : undefined;
}

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
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
    "apps/server/src/features/jobs/job-service.ts",
    "apps/server/src/features/canvas/generated-asset-application-adapter.ts",
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
