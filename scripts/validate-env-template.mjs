import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { envDescriptors } from "../packages/config/dist/env.js";

const descriptorByKey = new Map(envDescriptors.map((item) => [item.key, item]));

function templateEntries(source) {
  const entries = new Map();
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*#?\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (match) entries.set(match[1], match[2].split(/\s+#/)[0].trim());
  }
  return entries;
}

export function validateEnvironmentContracts({
  envTemplate,
  deployments,
  requireCompleteTemplate = true,
  serverDockerfileSource,
  serverHealthSource,
}) {
  const issues = [];
  const entries = templateEntries(envTemplate);
  for (const [key, value] of entries) {
    const descriptor = descriptorByKey.get(key);
    if (!descriptor) {
      issues.push(`.env.example: unknown key ${key}`);
    } else if (descriptor.dangerous && value === "true") {
      issues.push(
        `.env.example: dangerous setting ${key} must not default to true`,
      );
    }
  }
  if (requireCompleteTemplate) {
    for (const descriptor of envDescriptors) {
      if (!entries.has(descriptor.key)) {
        issues.push(`.env.example: missing documented key ${descriptor.key}`);
      }
    }
  }

  for (const deployment of deployments) {
    const processes = Array.isArray(deployment.metadata.processes)
      ? deployment.metadata.processes
      : [deployment.metadata.process];
    const variables = new Set(deployment.metadata.variables ?? []);
    const config = deployment.config;
    if (deployment.metadata.platform === "railway") {
      const runtimeEntrypoint = deployment.metadata.runtimeEntrypoint;
      const apiDatabaseGuard =
        deployment.metadata.process === "api"
          ? "test -n \\\"$SUPABASE_DB_URL\\\" || { echo 'SUPABASE_DB_URL is required for API realtime' >&2; exit 1; }; "
          : "";
      const expectedCommand = `sh -c "${apiDatabaseGuard}if [ -n \\"$GOOGLE_SERVICE_ACCOUNT_JSON\\" ]; then printf '%s' \\"$GOOGLE_SERVICE_ACCOUNT_JSON\\" > /app/credentials/vertex-ai-service-account.json && export GOOGLE_APPLICATION_CREDENTIALS=/app/credentials/vertex-ai-service-account.json; fi; exec node ${runtimeEntrypoint}"`;
      if (!config?.$schema?.includes("railway")) {
        issues.push(
          `${deployment.name}: invalid Railway ${deployment.metadata.process} service config`,
        );
      }
      if (config?.deploy?.startCommand !== expectedCommand) {
        issues.push(
          `${deployment.name}: startCommand must use the exact ${deployment.metadata.process.toUpperCase()} entrypoint`,
        );
      }
      if (
        serverDockerfileSource &&
        (!serverDockerfileSource.includes("WORKDIR /app") ||
          !serverDockerfileSource.includes(
            "COPY --from=builder /workspace/apps/server/dist ./dist",
          ) ||
          !serverDockerfileSource.includes(`node ${runtimeEntrypoint}`))
      ) {
        issues.push(
          `${deployment.name}: runtime entrypoint does not match the Docker filesystem layout`,
        );
      }
      for (const reference of shellVariableReferences(
        config?.deploy?.startCommand ?? "",
      )) {
        if (!descriptorByKey.has(reference)) {
          issues.push(
            `${deployment.name}: shell variable ${reference} has no environment descriptor`,
          );
        }
        if (!variables.has(reference)) {
          issues.push(
            `${deployment.name}: shell variable ${reference} is missing from the service contract`,
          );
        }
      }
      if (
        deployment.metadata.process === "api" &&
        config?.deploy?.healthcheckPath !== deployment.metadata.healthPath
      ) {
        issues.push(
          `${deployment.name}: API healthcheckPath must match ${deployment.metadata.healthPath}`,
        );
      }
      if (
        deployment.metadata.process === "api" &&
        serverHealthSource &&
        !serverHealthSource.includes(
          `app.get("${deployment.metadata.healthPath}"`,
        )
      ) {
        issues.push(
          `${deployment.name}: API health path is not registered by the server`,
        );
      }
    }
    if (deployment.metadata.platform === "vercel" && config?.env) {
      issues.push(
        `${deployment.name}: Vercel variables must be dashboard-managed, not declared in vercel.json`,
      );
    }
    if (!/dashboard/i.test(deployment.metadata.binding ?? "")) {
      issues.push(
        `${deployment.name}: missing dashboard variable binding instructions`,
      );
    }
    if (
      (deployment.metadata.process === "api" ||
        deployment.metadata.process === "worker") &&
      (!Array.isArray(deployment.metadata.providerAnyOf) ||
        deployment.metadata.providerAnyOf.length === 0)
    ) {
      issues.push(
        `${deployment.name}: missing providerAnyOf deployment contract`,
      );
    }
    for (const alternative of deployment.metadata.providerAnyOf ?? []) {
      for (const key of alternative) {
        if (!descriptorByKey.has(key) || !variables.has(key)) {
          issues.push(
            `${deployment.name}: provider alternative key ${key} is not declared`,
          );
        }
      }
    }
    for (const key of variables) {
      const descriptor = descriptorByKey.get(key);
      if (!descriptor) {
        issues.push(`${deployment.name}: unknown key ${key}`);
        continue;
      }
      const processMatches = processes.some((process) =>
        descriptor.processes.includes(process),
      );
      const exposureMatches = processes.every((process) =>
        process === "web"
          ? descriptor.sensitivity === "public"
          : descriptor.sensitivity !== "public" ||
            descriptor.processes.includes("api"),
      );
      if (!processMatches || !exposureMatches) {
        issues.push(
          `${deployment.name}: public/private process mismatch for ${key}`,
        );
      }
    }
    if (deployment.metadata.variables) {
      for (const descriptor of envDescriptors) {
        if (
          descriptor.requiredFor?.some((process) =>
            processes.includes(process),
          ) &&
          !variables.has(descriptor.key)
        ) {
          issues.push(
            `${deployment.name}: missing ${descriptor.key} required by ${processes.join("/")}`,
          );
        }
      }
    }
  }
  return issues;
}

function shellVariableReferences(command) {
  const references = new Set();
  for (const match of command.matchAll(
    /\$(?:\{([A-Z][A-Z0-9_]*)\}|([A-Z][A-Z0-9_]*))/g,
  )) {
    references.add(match[1] ?? match[2]);
  }
  return references;
}

async function main() {
  const root = new URL("../", import.meta.url);
  const [
    envTemplate,
    contract,
    rootRailway,
    serverDockerfileSource,
    serverHealthSource,
  ] = await Promise.all([
    readFile(new URL(".env.example", root), "utf8"),
    readFile(new URL("deploy/environment-contract.json", root), "utf8").then(
      JSON.parse,
    ),
    readFile(new URL("railway.json", root), "utf8").then(JSON.parse),
    readFile(new URL("apps/server/Dockerfile", root), "utf8"),
    readFile(new URL("apps/server/src/http/health.ts", root), "utf8"),
  ]);
  const deployments = await Promise.all(
    Object.entries(contract.services).map(async ([process, metadata]) => ({
      name: metadata.configPath,
      metadata: { ...metadata, process },
      config: JSON.parse(
        await readFile(new URL(metadata.configPath, root), "utf8"),
      ),
    })),
  );
  deployments.push({
    name: "railway.json",
    metadata: {
      ...contract.services.api,
      process: "api",
    },
    config: rootRailway,
  });
  const issues = validateEnvironmentContracts({
    envTemplate,
    deployments,
    serverDockerfileSource,
    serverHealthSource,
  });
  if (issues.length > 0) {
    console.error(
      `Environment contract validation failed:\n${issues.map((issue) => `- ${issue}`).join("\n")}`,
    );
    process.exitCode = 1;
  } else {
    console.log(
      `Environment contract validation passed (${envDescriptors.length} descriptors).`,
    );
  }
}

if (pathToFileURL(process.argv[1] ?? "").href === import.meta.url) {
  await main();
}
