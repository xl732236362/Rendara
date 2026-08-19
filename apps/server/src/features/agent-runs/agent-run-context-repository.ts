import type {
  AgentRunPrincipal,
  AgentSessionScope,
} from "../../application/agent/authorized-run-context.js";
import type { UserSupabaseClient } from "../../supabase/user.js";

const SESSION_SCOPE_SELECTION =
  "id, thread_id, canvas_id, canvases!inner(id, project_id, projects!inner(workspace_id))";

export function createAgentSessionScopeResolver(options: {
  createUserClient(accessToken: string): UserSupabaseClient;
}) {
  return async (
    principal: AgentRunPrincipal,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<AgentSessionScope | null> => {
    let query = options
      .createUserClient(principal.accessToken)
      .from("chat_sessions")
      .select(SESSION_SCOPE_SELECTION)
      .eq("id", sessionId);
    if (signal) query = query.abortSignal(signal);

    const { data, error } = await query.maybeSingle();
    if (error) throw new Error("agent_context_query_failed");
    return readSessionScope(data, sessionId);
  };
}

function readSessionScope(
  value: unknown,
  expectedSessionId: string,
): AgentSessionScope | null {
  if (!isRecord(value)) return null;
  const canvas = value.canvases;
  if (!isRecord(canvas)) return null;
  const project = canvas.projects;
  if (!isRecord(project)) return null;

  if (
    value.id !== expectedSessionId ||
    typeof value.thread_id !== "string" ||
    typeof value.canvas_id !== "string" ||
    canvas.id !== value.canvas_id ||
    typeof canvas.project_id !== "string" ||
    typeof project.workspace_id !== "string"
  ) {
    return null;
  }

  return {
    canvasId: value.canvas_id,
    projectId: canvas.project_id,
    sessionId: value.id,
    threadId: value.thread_id,
    workspaceId: project.workspace_id,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type ResolveAgentSessionScope = ReturnType<
  typeof createAgentSessionScopeResolver
>;
