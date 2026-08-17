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
      const expectedEntry =
        deployment.metadata.process === "worker" ? "worker.js" : "server.js";
      if (
        !config?.$schema?.includes("railway") ||
        !config.deploy?.startCommand?.includes(expectedEntry)
      ) {
        issues.push(
          `${deployment.name}: invalid Railway ${deployment.metadata.process} service config`,
        );
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

async function main() {
  const root = new URL("../", import.meta.url);
  const [envTemplate, contract, rootRailway, serverHealthSource] =
    await Promise.all([
      readFile(new URL(".env.example", root), "utf8"),
      readFile(new URL("deploy/environment-contract.json", root), "utf8").then(
        JSON.parse,
      ),
      readFile(new URL("railway.json", root), "utf8").then(JSON.parse),
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
