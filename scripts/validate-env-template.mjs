import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
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
  const [envTemplate, railway, vercel] = await Promise.all([
    readFile(new URL(".env.example", root), "utf8"),
    readFile(new URL("railway.json", root), "utf8").then(JSON.parse),
    readFile(new URL("vercel.json", root), "utf8").then(JSON.parse),
  ]);
  const deployments = [
    {
      name: "railway.json",
      metadata: { processes: Object.keys(railway.environments ?? {}) },
    },
    {
      name: "vercel.json",
      metadata: { process: "web", variables: Object.keys(vercel.env ?? {}) },
    },
  ];
  const issues = validateEnvironmentContracts({ envTemplate, deployments });
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
