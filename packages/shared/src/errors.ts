import { z } from "zod";

export const agentErrorCodeValues = [
  "agent_context_timeout",
  "agent_context_unavailable",
  "agent_context_forbidden",
  "agent_acceptance_indeterminate",
  "agent_acceptance_conflict",
  "agent_acceptance_unavailable",
  "agent_acceptance_failed",
  "agent_runtime_registration_failed",
  "agent_persistence_timeout",
  "agent_first_event_timeout",
  "agent_model_inactivity_timeout",
  "agent_tool_deadline_exceeded",
  "agent_overall_deadline_exceeded",
] as const;

export const errorCodeValues = [
  "invalid_request",
  "run_not_found",
  "run_conflict",
  "run_failed",
  "tool_failed",
  ...agentErrorCodeValues,
] as const;

export const agentErrorCodeSchema = z.enum(agentErrorCodeValues);
export const errorCodeSchema = z.enum(errorCodeValues);

export const loomicErrorSchema = z.object({
  code: errorCodeSchema,
  message: z.string().min(1),
  details: z.record(z.string(), z.unknown()).optional(),
});

export type LoomicErrorCode = z.infer<typeof errorCodeSchema>;
export type LoomicError = z.infer<typeof loomicErrorSchema>;
export type AgentErrorCode = z.infer<typeof agentErrorCodeSchema>;
