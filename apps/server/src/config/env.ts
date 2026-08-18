import { readFileSync } from "node:fs";
import {
  type ServerEnvironment,
  envDescriptors,
  parseServerEnvironment,
} from "@loomic/config/server";

export const DEFAULT_AGENT_MODEL = "gpt-4.1";
export const DEFAULT_GOOGLE_AGENT_MODEL = "gemini-2.5-flash";
export const DEFAULT_SERVER_PORT = 3001;
export const DEFAULT_WEB_ORIGIN = "http://localhost:3000";

export type ServerEnv = ServerEnvironment & { version: string };

export function resolveDefaultAgentModel(env: {
  googleApiKey?: string | undefined;
  googleVertexProject?: string | undefined;
  openAIApiKey?: string | undefined;
}): string {
  return !env.openAIApiKey && (env.googleApiKey || env.googleVertexProject)
    ? DEFAULT_GOOGLE_AGENT_MODEL
    : DEFAULT_AGENT_MODEL;
}

const propertyToKey = new Map(
  envDescriptors
    .filter((item) => item.property && item.key !== "PORT")
    .map((item) => [item.property, item.key]),
);

export function loadServerEnv(
  overrides: Partial<ServerEnv> = {},
  source: NodeJS.ProcessEnv = process.env,
  options: { process?: "api" | "worker" } = {},
): ServerEnv {
  const merged: Record<string, unknown> = { ...source };
  for (const [property, value] of Object.entries(overrides)) {
    if (property === "version" || value === undefined) continue;
    const key = propertyToKey.get(property as keyof ServerEnvironment);
    if (key) merged[key] = value;
  }
  return {
    ...parseServerEnvironment(merged, options),
    version: overrides.version ?? SERVER_VERSION,
  };
}

// Read once at module initialization rather than on every app/test parse.
const SERVER_VERSION = readServerVersion();

function readServerVersion(): string {
  const packageJson = readFileSync(
    new URL("../../package.json", import.meta.url),
    "utf8",
  );
  const parsed = JSON.parse(packageJson) as { version?: string };
  return parsed.version ?? "0.0.0";
}
