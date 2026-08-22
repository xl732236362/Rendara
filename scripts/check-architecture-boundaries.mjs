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
  boundedRoute("/api/jobs", "apps/server/src/http/jobs.ts", 50, {
    ownerFile: "apps/server/src/features/jobs/job-service.ts",
    ownerExport: "createJobService",
    method: "listJobs",
    kind: "awaited-query-call",
    queryVariable: "query",
    member: "limit",
  }),
  boundedRoute(
    "/api/canvases/:canvasId/generated-asset-attachments",
    "apps/server/src/http/jobs.ts",
    100,
    {
      ownerFile:
        "apps/server/src/features/canvas/generated-asset-application-adapter.ts",
      ownerExport: "createGeneratedAssetAttachmentRecoveryPort",
      method: "listOutstanding",
      kind: "call-argument-property",
      calleeRoot: "repository",
      calleeMethod: "listOutstanding",
      argumentIndex: 0,
      property: "limit",
    },
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

function boundedRoute(pathname, file, cap, capContract) {
  return Object.freeze({
    path: pathname,
    file,
    classification: "bounded",
    cap,
    capContract: Object.freeze(capContract),
    implementationEvidence: `${capContract.ownerFile}#${capContract.ownerExport}.${capContract.method}:${capContract.kind}:${capContract.member}`,
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
  if (ts.isIdentifier(current)) {
    const binding = resolveIdentifierBinding(current, context);
    if (binding?.initializer) {
      if (seen.has(binding.node)) return false;
      seen.add(binding.node);
      return isProvenQueryFactoryExpression(binding.initializer, context, seen);
    }
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
  const origin = resolveImportOrigin(access.rootNode, access.members, context);
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
      containsIdentityDerivedKey(node.initializer, context)
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

function containsIdentityDerivedKey(node, context) {
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
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      if (capturesTaintedBinding(current, context)) found = true;
      if (found) return;
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return found;
}

function capturesTaintedBinding(factory, context) {
  let captured = false;
  const localNames = new Set(
    factory.parameters.flatMap((parameter) =>
      bindingIdentifiers(parameter.name),
    ),
  );
  function collectLocals(node) {
    if (
      ts.isVariableDeclaration(node) &&
      findContainingFunction(node) === factory
    ) {
      for (const name of bindingIdentifiers(node.name)) localNames.add(name);
    }
    ts.forEachChild(node, collectLocals);
  }
  collectLocals(factory.body);
  function visit(node) {
    if (
      ts.isIdentifier(node) &&
      !localNames.has(node.text) &&
      isTaintedIdentifier(node, context)
    ) {
      captured = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(factory.body);
  return captured;
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
    if (defaultBinding) {
      const binding = resolveIdentifierBinding(defaultBinding, context);
      if (binding) domainBindings.add(binding.node);
    }
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const binding = resolveIdentifierBinding(element.name, context);
        if (binding) domainBindings.add(binding.node);
      }
    } else if (bindings && ts.isNamespaceImport(bindings)) {
      const binding = resolveIdentifierBinding(bindings.name, context);
      if (binding) domainBindings.add(binding.node);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const statement of context.sourceFile.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!declaration.initializer) continue;
        const root = rootAccess(declaration.initializer)?.rootNode;
        const rootBinding = root
          ? resolveIdentifierBinding(root, context)
          : undefined;
        if (!rootBinding || !domainBindings.has(rootBinding.node)) continue;
        for (const identifier of bindingIdentifierNodes(declaration.name)) {
          const binding = resolveIdentifierBinding(identifier, context);
          if (binding && !domainBindings.has(binding.node)) {
            domainBindings.add(binding.node);
            changed = true;
          }
        }
      }
    }
  }
  return collectMatchingNodes(
    context,
    (node) =>
      ts.isCallExpression(node) &&
      (isDomainBindingCall(node, domainBindings, context) ||
        isDirectV2Request(node, context)),
  ).map((finding) => ({
    ...finding,
    rule: "v2-fetch-ownership",
    message: "V2 collection fetches must be owned by the shared query layer",
  }));
}

function isDomainBindingCall(call, domainBindings, context) {
  const root = rootAccess(call.expression)?.rootNode;
  const binding = root ? resolveIdentifierBinding(root, context) : undefined;
  return binding ? domainBindings.has(binding.node) : false;
}

function isDirectV2Request(call, context) {
  const callee = resolveExpression(call.expression, context);
  if (!ts.isIdentifier(callee)) return false;
  if (!/^(?:fetch|apiFetch|request)$/.test(callee.text)) return false;
  const url = evaluateStaticString(call.arguments[0], context);
  return url.known
    ? url.value.includes("/api/v2/")
    : /^apps\/web\/src\/(?:app|components|hooks)\//.test(context.filePath);
}

function evaluateStaticString(expression, context, seen = new Set()) {
  const current = unwrapExpression(expression);
  if (!current)
    return { known: false, hasApiFragment: false, hasV2Binding: false };
  if (ts.isIdentifier(current)) {
    const binding = resolveIdentifierBinding(current, context);
    if (binding?.initializer) {
      if (seen.has(binding.node)) {
        return {
          known: false,
          hasApiFragment: false,
          hasV2Binding: /v2/i.test(current.text),
        };
      }
      seen.add(binding.node);
      const result = evaluateStaticString(binding.initializer, context, seen);
      return {
        ...result,
        hasV2Binding: result.hasV2Binding || /v2/i.test(current.text),
      };
    }
  }
  if (
    ts.isStringLiteral(current) ||
    ts.isNoSubstitutionTemplateLiteral(current)
  )
    return {
      known: true,
      value: current.text,
      hasApiFragment: current.text.includes("/api/"),
      hasV2Binding: current.text.includes("v2"),
    };
  if (ts.isTemplateExpression(current)) {
    let value = current.head.text;
    let known = true;
    let hasApiFragment = current.head.text.includes("/api/");
    let hasV2Binding = false;
    for (const span of current.templateSpans) {
      const substitution = evaluateStaticString(
        span.expression,
        context,
        new Set(seen),
      );
      known &&= substitution.known;
      if (substitution.known) value += substitution.value;
      value += span.literal.text;
      hasApiFragment ||=
        substitution.hasApiFragment || span.literal.text.includes("/api/");
      hasV2Binding ||=
        substitution.hasV2Binding || span.literal.text.includes("v2");
    }
    return { known, value, hasApiFragment, hasV2Binding };
  }
  if (
    ts.isBinaryExpression(current) &&
    current.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = evaluateStaticString(current.left, context, new Set(seen));
    const right = evaluateStaticString(current.right, context, new Set(seen));
    return {
      known: left.known && right.known,
      value: `${left.known ? left.value : ""}${right.known ? right.value : ""}`,
      hasApiFragment: left.hasApiFragment || right.hasApiFragment,
      hasV2Binding: left.hasV2Binding || right.hasV2Binding,
    };
  }
  return {
    known: false,
    hasApiFragment: current.getText(context.sourceFile).includes("/api/"),
    hasV2Binding:
      (ts.isIdentifier(current) && /v2/i.test(current.text)) ||
      current.getText(context.sourceFile).includes("v2"),
  };
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
  if (!expression) return undefined;
  const resolved = resolveExpression(expression, context);
  const access = rootAccess(resolved);
  if (!access) return undefined;
  return resolveImportOrigin(access.rootNode, access.members, context);
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
  return discoverGetRoutesInContext(context)
    .filter((route) => route.dynamic || !phase6AGetRoutesByPath.has(route.path))
    .map((route) =>
      phase6AFinding(
        "collection-route-inventory",
        "GET routes must have a static path classified by the Phase 6A inventory",
        route.evidenceNode,
        context,
      ),
    );
}

export function discoverPhase6AGetRoutes(sources) {
  const sourceGraph = createSourceGraph(sources);
  const routes = [];
  for (const [filePath, sourceFile] of sourceGraph) {
    if (!filePath.startsWith("apps/server/src/http/")) continue;
    const context = createPhase6AContext(filePath, sourceFile, sourceGraph);
    routes.push(
      ...discoverGetRoutesInContext(context).map((route) => ({
        ...route,
        filePath,
      })),
    );
  }
  return routes;
}

function discoverGetRoutesInContext(context) {
  const routes = [];
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const propertyCall = ts.isPropertyAccessExpression(node.expression);
      const receiverAccess = propertyCall
        ? rootAccess(node.expression.expression)
        : undefined;
      const methodName = propertyCall
        ? node.expression.name.text
        : ts.isIdentifier(node.expression)
          ? fastifyMethodForIdentifier(node.expression, context)
          : undefined;
      const fastifyCall = propertyCall
        ? receiverAccess !== undefined &&
          isFastifyReceiver(receiverAccess.rootNode, context)
        : methodName !== undefined;
      if (fastifyCall) {
        if (methodName === "get") {
          const pathExpression = node.arguments[0];
          const pathResult = evaluateStaticString(pathExpression, context);
          routes.push({
            path: pathResult.known ? pathResult.value : undefined,
            dynamic: !pathResult.known,
            handler: node.arguments.at(-1),
            evidenceNode: pathExpression ?? node,
          });
        }
        if (methodName === "route") {
          const options = resolveObjectProperties(node.arguments[0], context);
          const methods = evaluateHttpMethods(
            options.values.get("method"),
            context,
          );
          if (!methods.known || methods.values.has("GET")) {
            const pathExpression =
              options.values.get("url") ?? options.values.get("path");
            const pathResult = evaluateStaticString(pathExpression, context);
            routes.push({
              path: pathResult.known ? pathResult.value : undefined,
              dynamic: !methods.known || !pathResult.known,
              handler: options.values.get("handler"),
              evidenceNode: pathExpression ?? node,
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(context.sourceFile);
  return routes;
}

function isFastifyReceiver(identifier, context) {
  const binding = resolveIdentifierBinding(identifier, context);
  return binding ? context.fastifyBindingDeclarations.has(binding.node) : false;
}

function fastifyMethodForIdentifier(identifier, context) {
  const binding = resolveIdentifierBinding(identifier, context);
  return binding
    ? context.fastifyMethodDeclarations.get(binding.node)
    : undefined;
}

function evaluateHttpMethods(expression, context) {
  const resolved = resolveExpression(expression, context);
  if (ts.isStringLiteral(resolved)) {
    return { known: true, values: new Set([resolved.text.toUpperCase()]) };
  }
  if (ts.isArrayLiteralExpression(resolved)) {
    const values = new Set();
    for (const element of resolved.elements) {
      const result = evaluateStaticString(element, context);
      if (!result.known) return { known: false, values };
      values.add(result.value.toUpperCase());
    }
    return { known: true, values };
  }
  return { known: false, values: new Set() };
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
  const parameters = [];
  const taintSeeds = new Set();
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      for (const name of bindingIdentifiers(node.name)) {
        bindings.set(name, node.initializer);
      }
    }
    if (ts.isFunctionDeclaration(node) && node.name) {
      bindings.set(node.name.text, node);
    }
    if (ts.isParameter(node)) {
      parameters.push(node);
    }
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const moduleIsScoped = isScopedIdentityName(node.moduleSpecifier.text);
      const importClause = node.importClause;
      if (moduleIsScoped && importClause?.name) {
        taintSeeds.add(importClause.name.text);
      }
      const namedBindings = importClause?.namedBindings;
      if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) {
          const importedName = element.propertyName?.text ?? element.name.text;
          if (moduleIsScoped || isScopedIdentityName(importedName)) {
            taintSeeds.add(element.name.text);
          }
        }
      }
      if (
        moduleIsScoped &&
        namedBindings &&
        ts.isNamespaceImport(namedBindings)
      ) {
        taintSeeds.add(namedBindings.name.text);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  const context = {
    filePath,
    sourceFile,
    bindings,
    lexicalBindings: createLexicalBindings(sourceFile),
    sourceGraph,
  };
  context.taintedBindingDeclarations = computeTaintedBindings(
    parameters,
    taintSeeds,
    context,
  );
  const fastify = computeFastifyProvenance(sourceFile, context);
  context.fastifyBindingDeclarations = fastify.bindings;
  context.fastifyMethodDeclarations = fastify.methods;
  return context;
}

function createLexicalBindings(sourceFile) {
  const scopes = new Map();
  function scopeMap(scope) {
    let map = scopes.get(scope);
    if (!map) {
      map = new Map();
      scopes.set(scope, map);
    }
    return map;
  }
  function enclosingScope(node) {
    let current = node.parent;
    while (current) {
      if (
        ts.isSourceFile(current) ||
        ts.isBlock(current) ||
        ts.isCatchClause(current) ||
        ts.isArrowFunction(current) ||
        ts.isFunctionExpression(current) ||
        ts.isFunctionDeclaration(current)
      ) {
        return current;
      }
      current = current.parent;
    }
    return sourceFile;
  }
  function declare(nameNode, record, scope) {
    for (const name of bindingIdentifiers(nameNode)) {
      scopeMap(scope).set(name, { ...record, name });
    }
  }
  function visit(node) {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      if (clause?.name) {
        declare(
          clause.name,
          {
            kind: "import",
            node: clause.name,
            importKind: "default",
            declaration: node,
          },
          sourceFile,
        );
      }
      const named = clause?.namedBindings;
      if (named && ts.isNamedImports(named)) {
        for (const element of named.elements) {
          declare(
            element.name,
            {
              kind: "import",
              node: element.name,
              importKind: "named",
              exportName: element.propertyName?.text ?? element.name.text,
              declaration: node,
            },
            sourceFile,
          );
        }
      } else if (named && ts.isNamespaceImport(named)) {
        declare(
          named.name,
          {
            kind: "import",
            node: named.name,
            importKind: "namespace",
            declaration: node,
          },
          sourceFile,
        );
      }
    }
    if (ts.isVariableDeclaration(node)) {
      declare(
        node.name,
        { kind: "variable", node: node.name, initializer: node.initializer },
        enclosingScope(node),
      );
    }
    if (ts.isFunctionDeclaration(node) && node.name) {
      declare(
        node.name,
        { kind: "function", node: node.name, initializer: node },
        enclosingScope(node),
      );
    }
    if (ts.isParameter(node)) {
      const owner = node.parent;
      declare(node.name, { kind: "parameter", node: node.name }, owner);
    }
    if (ts.isCatchClause(node) && node.variableDeclaration) {
      declare(
        node.variableDeclaration.name,
        { kind: "catch", node: node.variableDeclaration.name },
        node,
      );
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return scopes;
}

function resolveIdentifierBinding(identifier, context) {
  if (!identifier || !ts.isIdentifier(identifier)) return undefined;
  let current = identifier.parent;
  while (current) {
    const binding = context.lexicalBindings?.get(current)?.get(identifier.text);
    if (binding) return binding;
    current = current.parent;
  }
  return undefined;
}

function computeTaintedBindings(parameters, taintSeeds, context) {
  const records = [
    ...new Set(
      [...context.lexicalBindings.values()].flatMap((scope) => [
        ...scope.values(),
      ]),
    ),
  ];
  const tainted = new Set();
  for (const record of records) {
    if (taintSeeds.has(record.name) || isScopedIdentityName(record.name)) {
      tainted.add(record.node);
    }
  }
  for (const parameter of parameters) {
    const typeText = parameter.type?.getText(context.sourceFile) ?? "";
    const names = bindingIdentifiers(parameter.name);
    if (names.some(isScopedIdentityName) || isScopedIdentityName(typeText)) {
      for (const node of bindingIdentifierNodes(parameter.name)) {
        const binding = resolveIdentifierBinding(node, context);
        if (binding) tainted.add(binding.node);
      }
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records) {
      if (tainted.has(record.node) || !record.initializer) continue;
      if (expressionReferencesTaint(record.initializer, tainted, context)) {
        tainted.add(record.node);
        changed = true;
      }
    }
  }
  return tainted;
}

function bindingIdentifiers(name) {
  if (ts.isIdentifier(name)) return [name.text];
  if (!ts.isObjectBindingPattern(name) && !ts.isArrayBindingPattern(name)) {
    return [];
  }
  const names = [];
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    names.push(...bindingIdentifiers(element.name));
  }
  return names;
}

function bindingIdentifierNodes(name) {
  if (ts.isIdentifier(name)) return [name];
  if (!ts.isObjectBindingPattern(name) && !ts.isArrayBindingPattern(name)) {
    return [];
  }
  const nodes = [];
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    nodes.push(...bindingIdentifierNodes(element.name));
  }
  return nodes;
}

function computeFastifyProvenance(sourceFile, context) {
  const bindings = new Set();
  const methods = new Map();
  const directFactories = new Set();
  const factoryNamespaces = new Set();
  const pluginTypes = new Set(["FastifyPluginAsync", "FastifyPluginCallback"]);
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "fastify"
    ) {
      continue;
    }
    const importClause = statement.importClause;
    if (importClause?.name) {
      const binding = resolveIdentifierBinding(importClause.name, context);
      if (binding) directFactories.add(binding.node);
    }
    const namedBindings = importClause?.namedBindings;
    if (namedBindings && ts.isNamedImports(namedBindings)) {
      for (const element of namedBindings.elements) {
        const importedName = element.propertyName?.text ?? element.name.text;
        if (/^(?:Fastify|fastify)$/.test(importedName)) {
          const binding = resolveIdentifierBinding(element.name, context);
          if (binding) directFactories.add(binding.node);
        }
        if (/^FastifyPlugin(?:Async|Callback)$/.test(importedName)) {
          pluginTypes.add(element.name.text);
        }
      }
    } else if (namedBindings && ts.isNamespaceImport(namedBindings)) {
      const binding = resolveIdentifierBinding(namedBindings.name, context);
      if (binding) factoryNamespaces.add(binding.node);
    }
  }
  let typeAliasesChanged = true;
  while (typeAliasesChanged) {
    typeAliasesChanged = false;
    for (const statement of sourceFile.statements) {
      if (!ts.isTypeAliasDeclaration(statement)) continue;
      const root = typeReferenceRoot(statement.type);
      if (
        root &&
        pluginTypes.has(root) &&
        !pluginTypes.has(statement.name.text)
      ) {
        pluginTypes.add(statement.name.text);
        typeAliasesChanged = true;
      }
    }
  }
  function resolveCallback(expression, seen = new Set()) {
    let current = unwrapExpression(expression);
    while (current && ts.isIdentifier(current)) {
      const binding = resolveIdentifierBinding(current, context);
      if (!binding?.initializer) return undefined;
      if (seen.has(binding.node)) return undefined;
      seen.add(binding.node);
      current = unwrapExpression(binding.initializer);
    }
    return current &&
      (ts.isArrowFunction(current) ||
        ts.isFunctionExpression(current) ||
        ts.isFunctionDeclaration(current))
      ? current
      : undefined;
  }
  function seedCallbackReceiver(expression) {
    const callback = resolveCallback(expression);
    const parameter = callback?.parameters[0];
    if (!parameter) return false;
    let added = false;
    for (const node of bindingIdentifierNodes(parameter.name)) {
      const binding = resolveIdentifierBinding(node, context);
      if (binding && !bindings.has(binding.node)) {
        bindings.add(binding.node);
        added = true;
      }
    }
    return added;
  }
  function isFastifyFactory(expression) {
    const access = rootAccess(expression);
    if (!access) return false;
    const binding = resolveIdentifierBinding(access.rootNode, context);
    if (!binding) return false;
    if (directFactories.has(binding.node) && access.members.length === 0) {
      return true;
    }
    return (
      factoryNamespaces.has(binding.node) &&
      access.members.length === 1 &&
      /^(?:default|Fastify|fastify)$/.test(access.members[0])
    );
  }
  function visitSeeds(node) {
    if (ts.isParameter(node)) {
      const typeText = node.type?.getText(sourceFile) ?? "";
      if (/\bFastifyInstance\b/.test(typeText)) {
        for (const identifier of bindingIdentifierNodes(node.name)) {
          const binding = resolveIdentifierBinding(identifier, context);
          if (binding) bindings.add(binding.node);
        }
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(unwrapExpression(node.initializer)) &&
      isFastifyFactory(unwrapExpression(node.initializer).expression)
    ) {
      const binding = resolveIdentifierBinding(node.name, context);
      if (binding) bindings.add(binding.node);
    }
    if (
      ts.isVariableDeclaration(node) &&
      node.type &&
      pluginTypes.has(typeReferenceRoot(node.type)) &&
      node.initializer
    ) {
      seedCallbackReceiver(node.initializer);
    }
    ts.forEachChild(node, visitSeeds);
  }
  visitSeeds(sourceFile);
  let changed = true;
  while (changed) {
    changed = false;
    function visitAliases(node) {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const root = rootAccess(node.initializer)?.rootNode;
        const rootBinding = root
          ? resolveIdentifierBinding(root, context)
          : undefined;
        if (rootBinding && bindings.has(rootBinding.node)) {
          if (ts.isIdentifier(node.name)) {
            const aliasBinding = resolveIdentifierBinding(node.name, context);
            if (aliasBinding && !bindings.has(aliasBinding.node)) {
              bindings.add(aliasBinding.node);
              changed = true;
            }
          }
          if (ts.isObjectBindingPattern(node.name)) {
            for (const element of node.name.elements) {
              const importedMethod = propertyName(
                element.propertyName ?? element.name,
              );
              for (const localNode of bindingIdentifierNodes(element.name)) {
                const localBinding = resolveIdentifierBinding(
                  localNode,
                  context,
                );
                if (
                  localBinding &&
                  (importedMethod === "get" || importedMethod === "route") &&
                  methods.get(localBinding.node) !== importedMethod
                ) {
                  methods.set(localBinding.node, importedMethod);
                  changed = true;
                }
              }
            }
          }
        } else if (
          ts.isIdentifier(node.name) &&
          rootBinding &&
          methods.has(rootBinding.node)
        ) {
          const method = methods.get(rootBinding.node);
          const aliasBinding = resolveIdentifierBinding(node.name, context);
          if (aliasBinding && methods.get(aliasBinding.node) !== method) {
            methods.set(aliasBinding.node, method);
            changed = true;
          }
        }
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "register"
      ) {
        const receiver = rootAccess(node.expression.expression)?.rootNode;
        const receiverBinding = receiver
          ? resolveIdentifierBinding(receiver, context)
          : undefined;
        if (
          receiverBinding &&
          bindings.has(receiverBinding.node) &&
          seedCallbackReceiver(node.arguments[0])
        ) {
          changed = true;
        }
      }
      ts.forEachChild(node, visitAliases);
    }
    visitAliases(sourceFile);
  }
  return { bindings, methods };
}

function typeReferenceRoot(typeNode) {
  let current = typeNode;
  while (ts.isParenthesizedTypeNode(current)) current = current.type;
  if (!ts.isTypeReferenceNode(current)) return undefined;
  let name = current.typeName;
  while (ts.isQualifiedName(name)) name = name.left;
  return ts.isIdentifier(name) ? name.text : undefined;
}

function expressionReferencesTaint(expression, tainted, context) {
  let found = false;
  function visit(node) {
    if (
      ts.isIdentifier(node) &&
      (isTaintedIdentifier(node, context, tainted) ||
        isScopedIdentityName(node.text))
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(expression);
  return found;
}

function isTaintedIdentifier(
  identifier,
  context,
  tainted = context.taintedBindingDeclarations,
) {
  const binding = resolveIdentifierBinding(identifier, context);
  return binding ? tainted.has(binding.node) : false;
}

function isScopedIdentityName(name) {
  return /(?:auth|viewer|user|workspace|session|canvas|owner|identity|scope)/i.test(
    name,
  );
}

function rootAccess(expression) {
  let current = unwrapExpression(expression);
  if (!current) return undefined;
  const members = [];
  while (ts.isPropertyAccessExpression(current)) {
    members.unshift(current.name.text);
    current = unwrapExpression(current.expression);
  }
  return ts.isIdentifier(current)
    ? { root: current.text, rootNode: current, members }
    : undefined;
}

function resolveImportOrigin(rootNode, members, context) {
  const binding = resolveIdentifierBinding(rootNode, context);
  if (binding?.kind !== "import") return undefined;
  const moduleSpecifier = binding.declaration.moduleSpecifier;
  if (!ts.isStringLiteral(moduleSpecifier)) return undefined;
  const modulePath = resolveModulePath(
    context.filePath,
    moduleSpecifier.text,
    context.sourceGraph,
  );
  if (binding.importKind === "default") {
    return resolveExportOrigin(modulePath, "default", context.sourceGraph);
  }
  if (binding.importKind === "named") {
    return resolveExportOrigin(
      modulePath,
      binding.exportName,
      context.sourceGraph,
    );
  }
  const [exportName] = members;
  return exportName
    ? resolveExportOrigin(modulePath, exportName, context.sourceGraph)
    : undefined;
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
  while (current && ts.isIdentifier(current)) {
    const binding = resolveIdentifierBinding(current, context);
    if (!binding?.initializer) break;
    if (seen.has(binding.node)) return current;
    seen.add(binding.node);
    current = unwrapExpression(binding.initializer);
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
  const registered = discoverPhase6AGetRoutes(sources);
  const discoveredCollections = new Set();
  for (const route of registered) {
    if (
      route.path &&
      route.handler &&
      containsCollectionServiceCall(route.handler)
    ) {
      discoveredCollections.add(route.path);
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
    if (route.dynamic) {
      issues.push(
        `${route.filePath} has a dynamic GET route missing from the inventory`,
      );
    } else if (!phase6AGetRoutesByPath.has(route.path)) {
      issues.push(`${route.path} is a GET route missing from the inventory`);
    }
  }
  return issues.sort();
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
  const contract = entry.capContract;
  if (!contract) return `${entry.path} has no structured cap contract`;
  const filePath = contract.ownerFile;
  const source = sourceByPath.get(filePath);
  if (!source) return `${entry.path} evidence source is missing: ${filePath}`;
  const sourceFile = parseSourceFile(source, filePath);
  let matched = false;
  function inspectMethod(method) {
    if (contract.kind === "awaited-query-call") {
      matched = provesAwaitedQueryCap(method, contract, entry.cap);
      return;
    }
    if (contract.kind === "call-argument-property") {
      matched = provesCallArgumentCap(method, contract, entry.cap);
    }
  }
  function visitOwner(node, insideOwner = false) {
    const isOwner =
      ts.isFunctionDeclaration(node) &&
      node.name?.text === contract.ownerExport &&
      node.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      );
    const owner = insideOwner || isOwner;
    if (
      owner &&
      ((ts.isMethodDeclaration(node) &&
        propertyName(node.name) === contract.method) ||
        (ts.isPropertyAssignment(node) &&
          propertyName(node.name) === contract.method &&
          (ts.isArrowFunction(node.initializer) ||
            ts.isFunctionExpression(node.initializer))) ||
        (ts.isMethodSignature(node) &&
          propertyName(node.name) === contract.method))
    ) {
      inspectMethod(node);
      return;
    }
    ts.forEachChild(node, (child) => visitOwner(child, owner));
  }
  visitOwner(sourceFile);
  return matched
    ? undefined
    : `${entry.path} cap ${entry.cap} is not proven by ${entry.implementationEvidence}`;
}

function provesAwaitedQueryCap(method, contract, cap) {
  const body = method.body ?? method.initializer?.body;
  if (!body) return false;
  const context = {
    sourceFile: method.getSourceFile(),
    lexicalBindings: createLexicalBindings(method.getSourceFile()),
  };
  const queryBinding = context.lexicalBindings
    .get(body)
    ?.get(contract.queryVariable);
  if (queryBinding?.kind !== "variable" || !queryBinding.initializer) {
    return false;
  }
  let consumptionPosition = Number.POSITIVE_INFINITY;
  function findQueryFlow(node) {
    if (isNestedExecutableBoundary(node)) return;
    if (ts.isAwaitExpression(node)) {
      const root = rootAccess(node.expression)?.rootNode;
      const binding = root
        ? resolveIdentifierBinding(root, context)
        : undefined;
      if (binding?.node === queryBinding.node) {
        consumptionPosition = Math.min(consumptionPosition, node.pos);
      }
    }
    if (ts.isReturnStatement(node) && node.expression) {
      const root = rootAccess(node.expression)?.rootNode;
      const binding = root
        ? resolveIdentifierBinding(root, context)
        : undefined;
      if (binding?.node === queryBinding.node) {
        consumptionPosition = Math.min(consumptionPosition, node.pos);
      }
    }
    ts.forEachChild(node, findQueryFlow);
  }
  findQueryFlow(body);
  if (!Number.isFinite(consumptionPosition)) return false;

  const flowExpressions = [queryBinding.initializer];
  function collectAssignments(node) {
    if (isNestedExecutableBoundary(node)) return;
    if (node.pos >= consumptionPosition) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(unwrapExpression(node.left))
    ) {
      const binding = resolveIdentifierBinding(
        unwrapExpression(node.left),
        context,
      );
      if (binding?.node === queryBinding.node) flowExpressions.push(node.right);
    }
    ts.forEachChild(node, collectAssignments);
  }
  collectAssignments(body);
  return flowExpressions.some((expression) =>
    containsLiteralMemberCall(expression, contract.member, cap),
  );
}

function isNestedExecutableBoundary(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node)
  );
}

function containsLiteralMemberCall(expression, member, cap) {
  let matched = false;
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === member &&
      numericLiteralValue(node.arguments[0]) === cap
    ) {
      matched = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(expression);
  return matched;
}

function provesCallArgumentCap(method, contract, cap) {
  let matched = false;
  function visit(node) {
    if (!ts.isCallExpression(node)) {
      ts.forEachChild(node, visit);
      return;
    }
    const access = rootAccess(node.expression);
    const isContractCall =
      access?.root === contract.calleeRoot &&
      access.members.length === 1 &&
      access.members[0] === contract.calleeMethod;
    if (isContractCall) {
      const argument = unwrapExpression(node.arguments[contract.argumentIndex]);
      if (argument && ts.isObjectLiteralExpression(argument)) {
        matched = argument.properties.some(
          (property) =>
            ts.isPropertyAssignment(property) &&
            propertyName(property.name) === contract.property &&
            numericLiteralValue(property.initializer) === cap,
        );
      }
    }
    if (!matched) ts.forEachChild(node, visit);
  }
  visit(method);
  return matched;
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
