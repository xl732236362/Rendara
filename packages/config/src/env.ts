import { z } from "zod";

export type LoomicProcess = "api" | "worker" | "web";
export type EnvSensitivity = "public" | "private" | "secret";

export type EnvDescriptor = Readonly<{
  key: string;
  property?: keyof ServerEnvironment;
  sensitivity: EnvSensitivity;
  processes: readonly LoomicProcess[];
  dangerous?: boolean;
  requiredFor?: readonly LoomicProcess[];
}>;

const descriptor = (
  key: string,
  property: keyof ServerEnvironment | undefined,
  sensitivity: EnvSensitivity,
  processes: readonly LoomicProcess[],
  extra: Pick<EnvDescriptor, "dangerous" | "requiredFor"> = {},
): EnvDescriptor => ({
  key,
  ...(property ? { property } : {}),
  sensitivity,
  processes,
  ...extra,
});

export type AgentBackendMode = "filesystem" | "state";
export type ServerEnvironment = {
  agentBackendMode: AgentBackendMode;
  agentFilesRoot?: string;
  agentModel: string;
  allowExternalSkillImport: boolean;
  allowLocalAgentExecute: boolean;
  googleApiKey?: string;
  googleApplicationCredentials?: string;
  googleServiceAccountJson?: string;
  googleFontsApiKey?: string;
  googleVertexLocation?: string;
  googleVertexProject?: string;
  googleVertexVideoLocation?: string;
  openAIApiBase?: string;
  openAIApiKey?: string;
  port: number;
  rateLimitDefaultPerMinute: number;
  rateLimitGenerationPerMinute: number;
  rateLimitImageProxyPerMinute: number;
  rateLimitSkillImportPerHour: number;
  rateLimitUploadsPerMinute: number;
  replicateApiToken?: string;
  supabaseAnonKey?: string;
  supabaseDbUrl?: string;
  supabaseJwtSecret?: string;
  supabaseProjectId?: string;
  supabaseServiceRoleKey?: string;
  supabaseUrl?: string;
  volcesApiKey?: string;
  volcesBaseUrl?: string;
  skillsRoot?: string;
  workerConcurrency?: number;
  workerImageConcurrency?: number;
  workerVideoConcurrency?: number;
  workerId?: string;
  workerPollIntervalMs?: number;
  workerMaxBatchSize?: number;
  lemonSqueezyApiKey?: string;
  lemonSqueezyStoreId?: string;
  lemonSqueezyWebhookSecret?: string;
  lemonSqueezyVariantStarterMonthly?: string;
  lemonSqueezyVariantStarterYearly?: string;
  lemonSqueezyVariantProMonthly?: string;
  lemonSqueezyVariantProYearly?: string;
  lemonSqueezyVariantUltraMonthly?: string;
  lemonSqueezyVariantUltraYearly?: string;
  lemonSqueezyVariantBusinessMonthly?: string;
  lemonSqueezyVariantBusinessYearly?: string;
  webOrigin: string;
};

export const envDescriptors = [
  descriptor("LOOMIC_SERVER_PORT", "port", "private", ["api"]),
  descriptor("PORT", "port", "private", ["api"]),
  descriptor("LOOMIC_AGENT_BACKEND_MODE", "agentBackendMode", "private", [
    "api",
    "worker",
  ]),
  descriptor("LOOMIC_WEB_ORIGIN", "webOrigin", "public", ["api"]),
  descriptor("NEXT_PUBLIC_SERVER_BASE_URL", undefined, "public", ["web"]),
  descriptor("SUPABASE_URL", "supabaseUrl", "private", ["api", "worker"], {
    requiredFor: ["api", "worker"],
  }),
  descriptor(
    "SUPABASE_ANON_KEY",
    "supabaseAnonKey",
    "secret",
    ["api", "worker"],
    { requiredFor: ["api", "worker"] },
  ),
  descriptor(
    "SUPABASE_SERVICE_ROLE_KEY",
    "supabaseServiceRoleKey",
    "secret",
    ["api", "worker"],
    { requiredFor: ["api", "worker"] },
  ),
  descriptor("SUPABASE_DB_URL", "supabaseDbUrl", "secret", ["worker"], {
    requiredFor: ["worker"],
  }),
  descriptor("SUPABASE_PROJECT_ID", "supabaseProjectId", "private", [
    "api",
    "worker",
  ]),
  descriptor("SUPABASE_JWT_SECRET", "supabaseJwtSecret", "secret", [
    "api",
    "worker",
  ]),
  descriptor("NEXT_PUBLIC_SUPABASE_URL", undefined, "public", ["web"]),
  descriptor("NEXT_PUBLIC_SUPABASE_ANON_KEY", undefined, "public", ["web"]),
  descriptor("LOOMIC_AGENT_MODEL", "agentModel", "private", ["api", "worker"]),
  descriptor("OPENAI_API_KEY", "openAIApiKey", "secret", ["api", "worker"]),
  descriptor("OPENAI_API_BASE", "openAIApiBase", "private", ["api", "worker"]),
  descriptor("GOOGLE_API_KEY", "googleApiKey", "secret", ["api", "worker"]),
  descriptor(
    "GOOGLE_APPLICATION_CREDENTIALS",
    "googleApplicationCredentials",
    "private",
    ["api", "worker"],
  ),
  descriptor(
    "GOOGLE_SERVICE_ACCOUNT_JSON",
    "googleServiceAccountJson",
    "secret",
    ["api", "worker"],
  ),
  descriptor("GOOGLE_FONTS_API_KEY", "googleFontsApiKey", "secret", ["api"]),
  descriptor("GOOGLE_VERTEX_PROJECT", "googleVertexProject", "private", [
    "api",
    "worker",
  ]),
  descriptor("GOOGLE_VERTEX_LOCATION", "googleVertexLocation", "private", [
    "api",
    "worker",
  ]),
  descriptor(
    "GOOGLE_VERTEX_VIDEO_LOCATION",
    "googleVertexVideoLocation",
    "private",
    ["api", "worker"],
  ),
  descriptor("REPLICATE_API_TOKEN", "replicateApiToken", "secret", [
    "api",
    "worker",
  ]),
  descriptor("VOLCES_API_KEY", "volcesApiKey", "secret", ["api", "worker"]),
  descriptor("VOLCES_BASE_URL", "volcesBaseUrl", "private", ["api", "worker"]),
  descriptor("LOOMIC_AGENT_FILES_ROOT", "agentFilesRoot", "private", ["api"]),
  descriptor("LOOMIC_SKILLS_ROOT", "skillsRoot", "private", ["api", "worker"]),
  descriptor(
    "LOOMIC_ALLOW_LOCAL_AGENT_EXECUTE",
    "allowLocalAgentExecute",
    "private",
    ["api"],
    { dangerous: true },
  ),
  descriptor(
    "LOOMIC_ALLOW_EXTERNAL_SKILL_IMPORT",
    "allowExternalSkillImport",
    "private",
    ["api"],
    { dangerous: true },
  ),
  descriptor(
    "LOOMIC_RATE_LIMIT_DEFAULT_PER_MINUTE",
    "rateLimitDefaultPerMinute",
    "private",
    ["api"],
  ),
  descriptor(
    "LOOMIC_RATE_LIMIT_GENERATION_PER_MINUTE",
    "rateLimitGenerationPerMinute",
    "private",
    ["api"],
  ),
  descriptor(
    "LOOMIC_RATE_LIMIT_IMAGE_PROXY_PER_MINUTE",
    "rateLimitImageProxyPerMinute",
    "private",
    ["api"],
  ),
  descriptor(
    "LOOMIC_RATE_LIMIT_SKILL_IMPORT_PER_HOUR",
    "rateLimitSkillImportPerHour",
    "private",
    ["api"],
  ),
  descriptor(
    "LOOMIC_RATE_LIMIT_UPLOADS_PER_MINUTE",
    "rateLimitUploadsPerMinute",
    "private",
    ["api"],
  ),
  descriptor("WORKER_CONCURRENCY", "workerConcurrency", "private", ["worker"]),
  descriptor("WORKER_IMAGE_CONCURRENCY", "workerImageConcurrency", "private", [
    "worker",
  ]),
  descriptor("WORKER_VIDEO_CONCURRENCY", "workerVideoConcurrency", "private", [
    "worker",
  ]),
  descriptor("WORKER_ID", "workerId", "private", ["worker"]),
  descriptor("WORKER_POLL_INTERVAL_MS", "workerPollIntervalMs", "private", [
    "worker",
  ]),
  descriptor("WORKER_MAX_BATCH_SIZE", "workerMaxBatchSize", "private", [
    "worker",
  ]),
  descriptor("LEMONSQUEEZY_API_KEY", "lemonSqueezyApiKey", "secret", ["api"]),
  descriptor("LEMONSQUEEZY_STORE_ID", "lemonSqueezyStoreId", "private", [
    "api",
  ]),
  descriptor(
    "LEMONSQUEEZY_WEBHOOK_SECRET",
    "lemonSqueezyWebhookSecret",
    "secret",
    ["api"],
  ),
  descriptor(
    "LEMONSQUEEZY_VARIANT_STARTER_MONTHLY",
    "lemonSqueezyVariantStarterMonthly",
    "private",
    ["api"],
  ),
  descriptor(
    "LEMONSQUEEZY_VARIANT_STARTER_YEARLY",
    "lemonSqueezyVariantStarterYearly",
    "private",
    ["api"],
  ),
  descriptor(
    "LEMONSQUEEZY_VARIANT_PRO_MONTHLY",
    "lemonSqueezyVariantProMonthly",
    "private",
    ["api"],
  ),
  descriptor(
    "LEMONSQUEEZY_VARIANT_PRO_YEARLY",
    "lemonSqueezyVariantProYearly",
    "private",
    ["api"],
  ),
  descriptor(
    "LEMONSQUEEZY_VARIANT_ULTRA_MONTHLY",
    "lemonSqueezyVariantUltraMonthly",
    "private",
    ["api"],
  ),
  descriptor(
    "LEMONSQUEEZY_VARIANT_ULTRA_YEARLY",
    "lemonSqueezyVariantUltraYearly",
    "private",
    ["api"],
  ),
  descriptor(
    "LEMONSQUEEZY_VARIANT_BUSINESS_MONTHLY",
    "lemonSqueezyVariantBusinessMonthly",
    "private",
    ["api"],
  ),
  descriptor(
    "LEMONSQUEEZY_VARIANT_BUSINESS_YEARLY",
    "lemonSqueezyVariantBusinessYearly",
    "private",
    ["api"],
  ),
  descriptor("GLOBAL_AGENT_HTTP_PROXY", undefined, "private", [
    "api",
    "worker",
  ]),
] as const satisfies readonly EnvDescriptor[];

const blankToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;
const optionalString = z.preprocess(
  blankToUndefined,
  z.string().trim().min(1).optional(),
);
const optionalUrl = z.preprocess(blankToUndefined, z.url().trim().optional());
const strictInteger = (minimum: number, maximum: number) =>
  z.preprocess(
    (value: unknown) =>
      typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value,
    z.number().int().min(minimum).max(maximum),
  );
const optionalInteger = (minimum: number, maximum: number) =>
  z.preprocess(
    (value: unknown) =>
      value === undefined || value === ""
        ? undefined
        : typeof value === "string" && /^\d+$/.test(value)
          ? Number(value)
          : value,
    z.number().int().min(minimum).max(maximum).optional(),
  );
const exactBoolean = z.preprocess((value: unknown) => {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}, z.boolean());

export const serverEnvironmentSchema = z.object({
  LOOMIC_SERVER_PORT: strictInteger(1, 65_535).optional(),
  PORT: strictInteger(1, 65_535).optional(),
  LOOMIC_AGENT_BACKEND_MODE: z.enum(["state", "filesystem"]).default("state"),
  LOOMIC_WEB_ORIGIN: z.url().trim().default("http://localhost:3000"),
  SUPABASE_URL: optionalUrl,
  SUPABASE_ANON_KEY: optionalString,
  SUPABASE_SERVICE_ROLE_KEY: optionalString,
  SUPABASE_DB_URL: optionalString,
  SUPABASE_PROJECT_ID: optionalString,
  SUPABASE_JWT_SECRET: optionalString,
  LOOMIC_AGENT_MODEL: optionalString,
  OPENAI_API_KEY: optionalString,
  OPENAI_API_BASE: optionalUrl,
  GOOGLE_API_KEY: optionalString,
  GOOGLE_APPLICATION_CREDENTIALS: optionalString,
  GOOGLE_SERVICE_ACCOUNT_JSON: optionalString,
  GOOGLE_FONTS_API_KEY: optionalString,
  GOOGLE_VERTEX_PROJECT: optionalString,
  GOOGLE_VERTEX_LOCATION: optionalString,
  GOOGLE_VERTEX_VIDEO_LOCATION: optionalString,
  REPLICATE_API_TOKEN: optionalString,
  VOLCES_API_KEY: optionalString,
  VOLCES_BASE_URL: optionalUrl,
  LOOMIC_AGENT_FILES_ROOT: optionalString,
  LOOMIC_SKILLS_ROOT: optionalString,
  LOOMIC_ALLOW_LOCAL_AGENT_EXECUTE: exactBoolean.default(false),
  LOOMIC_ALLOW_EXTERNAL_SKILL_IMPORT: exactBoolean.default(false),
  LOOMIC_RATE_LIMIT_DEFAULT_PER_MINUTE: strictInteger(1, 100_000).default(300),
  LOOMIC_RATE_LIMIT_GENERATION_PER_MINUTE: strictInteger(1, 100_000).default(
    10,
  ),
  LOOMIC_RATE_LIMIT_IMAGE_PROXY_PER_MINUTE: strictInteger(1, 100_000).default(
    60,
  ),
  LOOMIC_RATE_LIMIT_SKILL_IMPORT_PER_HOUR: strictInteger(1, 100_000).default(5),
  LOOMIC_RATE_LIMIT_UPLOADS_PER_MINUTE: strictInteger(1, 100_000).default(20),
  WORKER_CONCURRENCY: optionalInteger(1, 1_000),
  WORKER_IMAGE_CONCURRENCY: optionalInteger(1, 1_000),
  WORKER_VIDEO_CONCURRENCY: optionalInteger(1, 1_000),
  WORKER_ID: optionalString,
  WORKER_POLL_INTERVAL_MS: optionalInteger(100, 3_600_000),
  WORKER_MAX_BATCH_SIZE: optionalInteger(1, 1_000),
  LEMONSQUEEZY_API_KEY: optionalString,
  LEMONSQUEEZY_STORE_ID: optionalString,
  LEMONSQUEEZY_WEBHOOK_SECRET: optionalString,
  LEMONSQUEEZY_VARIANT_STARTER_MONTHLY: optionalString,
  LEMONSQUEEZY_VARIANT_STARTER_YEARLY: optionalString,
  LEMONSQUEEZY_VARIANT_PRO_MONTHLY: optionalString,
  LEMONSQUEEZY_VARIANT_PRO_YEARLY: optionalString,
  LEMONSQUEEZY_VARIANT_ULTRA_MONTHLY: optionalString,
  LEMONSQUEEZY_VARIANT_ULTRA_YEARLY: optionalString,
  LEMONSQUEEZY_VARIANT_BUSINESS_MONTHLY: optionalString,
  LEMONSQUEEZY_VARIANT_BUSINESS_YEARLY: optionalString,
});

export class ConfigValidationError extends Error {
  readonly issues: readonly { key: string; message: string }[];
  constructor(issues: readonly { key: string; message: string }[]) {
    super(
      `Invalid environment configuration:\n${issues.map(({ key, message }) => `- ${key}: ${message}`).join("\n")}`,
    );
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}

export function parseServerEnvironment(
  source: Record<string, unknown>,
  options: { process?: "api" | "worker" } = {},
): ServerEnvironment {
  const result = serverEnvironmentSchema.safeParse(source);
  const issues = result.success
    ? []
    : result.error.issues.map((issue) => ({
        key: String(issue.path[0] ?? "environment"),
        message: issue.message,
      }));
  const raw = result.success ? result.data : undefined;
  const candidate = {
    agentModel: normalizedCandidate(source.LOOMIC_AGENT_MODEL),
    googleApplicationCredentials: normalizedCandidate(
      source.GOOGLE_APPLICATION_CREDENTIALS,
    ),
    googleApiKey: normalizedCandidate(source.GOOGLE_API_KEY),
    googleServiceAccountJson: normalizedCandidate(
      source.GOOGLE_SERVICE_ACCOUNT_JSON,
    ),
    googleVertexLocation: normalizedCandidate(source.GOOGLE_VERTEX_LOCATION),
    googleVertexProject: normalizedCandidate(source.GOOGLE_VERTEX_PROJECT),
    openAIApiKey: normalizedCandidate(source.OPENAI_API_KEY),
    supabaseAnonKey: normalizedCandidate(source.SUPABASE_ANON_KEY),
    supabaseDbUrl: normalizedCandidate(source.SUPABASE_DB_URL),
    supabaseServiceRoleKey: normalizedCandidate(
      source.SUPABASE_SERVICE_ROLE_KEY,
    ),
    supabaseUrl: normalizedCandidate(source.SUPABASE_URL),
  };
  if (options.process) {
    for (const [key, present] of [
      ["SUPABASE_URL", candidate.supabaseUrl],
      ["SUPABASE_ANON_KEY", candidate.supabaseAnonKey],
      ["SUPABASE_SERVICE_ROLE_KEY", candidate.supabaseServiceRoleKey],
      ...(options.process === "worker"
        ? [["SUPABASE_DB_URL", candidate.supabaseDbUrl]]
        : []),
    ] as const) {
      if (!present) {
        issues.push({
          key: String(key),
          message: `is required for the ${options.process} process`,
        });
      }
    }
  }
  const resolvedAgentModel =
    candidate.agentModel ??
    (!candidate.openAIApiKey &&
    (candidate.googleApiKey || candidate.googleVertexProject)
      ? "gemini-2.5-flash"
      : "gpt-4.1");
  const validateProvider = Boolean(options.process || candidate.agentModel);
  const usesGoogle =
    resolvedAgentModel.startsWith("google:") ||
    resolvedAgentModel.includes("gemini");
  if (validateProvider && !usesGoogle && !candidate.openAIApiKey) {
    issues.push({
      key: "OPENAI_API_KEY",
      message: "is required by the selected OpenAI model",
    });
  }
  if (
    validateProvider &&
    usesGoogle &&
    !candidate.googleApiKey &&
    !(candidate.googleVertexProject && candidate.googleVertexLocation)
  ) {
    issues.push({
      key: "GOOGLE_API_KEY",
      message:
        "or complete Google Vertex configuration is required by the selected Google model",
    });
  }
  if (
    validateProvider &&
    usesGoogle &&
    !candidate.googleApiKey &&
    candidate.googleVertexProject &&
    candidate.googleVertexLocation &&
    !candidate.googleApplicationCredentials &&
    !candidate.googleServiceAccountJson
  ) {
    issues.push({
      key: "GOOGLE_APPLICATION_CREDENTIALS",
      message: "or GOOGLE_SERVICE_ACCOUNT_JSON is required for Vertex",
    });
    issues.push({
      key: "GOOGLE_SERVICE_ACCOUNT_JSON",
      message: "or GOOGLE_APPLICATION_CREDENTIALS is required for Vertex",
    });
  }
  if (issues.length > 0) throw new ConfigValidationError(issues);
  if (!raw) {
    throw new ConfigValidationError([
      { key: "environment", message: "could not be parsed" },
    ]);
  }

  const output: Record<string, unknown> = {};
  for (const item of envDescriptors) {
    if (!item.property) continue;
    const value = raw[item.key as keyof typeof raw];
    if (value !== undefined) output[item.property] = value;
  }
  output.port = raw.LOOMIC_SERVER_PORT ?? raw.PORT ?? 3001;
  output.agentModel = resolvedAgentModel;
  return output as ServerEnvironment;
}

export { ConfigValidationError as EnvironmentValidationError };

function normalizedCandidate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim() || undefined;
}
