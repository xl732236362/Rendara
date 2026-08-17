export const configPackageName = "@loomic/config" as const;

export const configPackageDescription =
  "Shared configuration entrypoint for the Loomic monorepo." as const;

export {
  EnvironmentValidationError,
  envDescriptors,
  parseServerEnvironment,
  serverEnvironmentSchema,
  type AgentBackendMode,
  type EnvDescriptor,
  type EnvSensitivity,
  type LoomicProcess,
  type ServerEnvironment,
} from "./env.js";
