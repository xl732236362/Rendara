import { z } from "zod";

import { agentCapabilitySchema } from "./capabilities.js";

export const agentExecutionContextSchema = z.object({
  runId: z.string().min(1),
  attemptId: z.string().min(1),
  userId: z.string().min(1),
  workspaceId: z.string().min(1),
  projectId: z.string().min(1),
  canvasId: z.string().min(1),
  capabilities: z.array(agentCapabilitySchema),
  capabilityPolicyVersion: z.string().min(1),
  skillCatalogDigest: z.string().min(1),
  effectiveSkillNames: z.array(z.string().min(1)),
});

export type AgentExecutionContext = Omit<
  z.infer<typeof agentExecutionContextSchema>,
  "capabilities" | "effectiveSkillNames"
> & {
  readonly capabilities: readonly z.infer<typeof agentCapabilitySchema>[];
  readonly effectiveSkillNames: readonly string[];
};

export function freezeExecutionContext(
  input: AgentExecutionContext,
): Readonly<AgentExecutionContext> {
  const parsed = agentExecutionContextSchema.parse(input);
  return Object.freeze({
    ...parsed,
    capabilities: Object.freeze([...new Set(parsed.capabilities)].sort()),
    effectiveSkillNames: Object.freeze(
      [...new Set(parsed.effectiveSkillNames)].sort(),
    ),
  });
}
