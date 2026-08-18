import { createHash } from "node:crypto";

import { z } from "zod";

export const agentCapabilitySchema = z.enum([
  "skill.read",
  "canvas.read",
  "canvas.mutate",
  "asset.persist",
  "image.generate",
  "video.generate",
  "brand_kit.read",
  "project.search",
  "agent.delegate",
]);

export type AgentCapability = z.infer<typeof agentCapabilitySchema>;

export const PRODUCTION_AGENT_CAPABILITIES = Object.freeze([
  "skill.read",
  "canvas.read",
  "canvas.mutate",
  "asset.persist",
  "image.generate",
  "video.generate",
  "brand_kit.read",
  "agent.delegate",
] satisfies AgentCapability[]);

export const FORBIDDEN_AGENT_TOOL_NAMES = Object.freeze([
  "execute",
  "ls",
  "glob",
  "grep",
  "read_file",
  "write_file",
  "edit_file",
  "shell",
  "bash",
  "python",
  "spawn_process",
  "install_package",
  "fetch",
] as const);

const CAPABILITY_TOOLS = Object.freeze({
  "skill.read": ["read_builtin_skill"],
  "canvas.read": ["inspect_canvas", "screenshot_canvas"],
  "canvas.mutate": ["manipulate_canvas"],
  "asset.persist": [],
  "image.generate": ["generate_image"],
  "video.generate": ["generate_video"],
  "brand_kit.read": ["get_brand_kit"],
  "project.search": ["project_search"],
  "agent.delegate": [],
} satisfies Record<AgentCapability, readonly string[]>);

export const CLASSIFIED_AGENT_TOOL_NAMES = Object.freeze(
  [
    ...new Set([
      ...Object.values(CAPABILITY_TOOLS).flat(),
      ...FORBIDDEN_AGENT_TOOL_NAMES,
    ]),
  ].sort(),
);

export interface AgentSubagentAuthority {
  readonly name: "video_generate";
  readonly capabilities: readonly AgentCapability[];
  readonly toolNames: readonly string[];
}

export interface AgentAuthority {
  readonly capabilities: readonly AgentCapability[];
  readonly mainToolNames: readonly string[];
  readonly subagents: readonly AgentSubagentAuthority[];
  readonly policyVersion: string;
}

export function createAgentAuthority(
  capabilities: readonly AgentCapability[],
): AgentAuthority {
  const effectiveCapabilities = Object.freeze(
    [...new Set(agentCapabilitySchema.array().parse(capabilities))].sort(),
  );
  const capabilitySet = new Set(effectiveCapabilities);
  const mainToolNames = Object.freeze(
    [
      ...new Set(
        effectiveCapabilities.flatMap((item) => CAPABILITY_TOOLS[item]),
      ),
    ].sort(),
  );
  const subagents: readonly AgentSubagentAuthority[] =
    capabilitySet.has("agent.delegate") && capabilitySet.has("video.generate")
      ? Object.freeze([
          Object.freeze({
            name: "video_generate" as const,
            capabilities: Object.freeze(["video.generate" as const]),
            toolNames: Object.freeze(["generate_video"]),
          }),
        ])
      : Object.freeze([]);
  const policy = {
    schemaVersion: 1,
    capabilities: effectiveCapabilities,
    mainToolNames,
    subagents,
    forbiddenToolNames: FORBIDDEN_AGENT_TOOL_NAMES,
  };

  return Object.freeze({
    capabilities: effectiveCapabilities,
    mainToolNames,
    subagents,
    policyVersion: createHash("sha256")
      .update(JSON.stringify(policy))
      .digest("hex"),
  });
}
