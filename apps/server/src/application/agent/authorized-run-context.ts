import type { RunCreateRequest } from "@loomic/shared";

import { AgentRunError } from "./agent-run-errors.js";

export type AgentRunPrincipal = Readonly<{
  accessToken: string;
  userId: string;
}>;

export type AuthorizedAgentRunContext = Readonly<{
  accessToken: string;
  canvasId: string;
  conversationId: string;
  projectId: string;
  sessionId: string;
  threadId: string;
  userId: string;
  workspaceId: string;
}>;

export type AgentSessionScope = Readonly<
  Omit<AuthorizedAgentRunContext, "accessToken" | "conversationId" | "userId">
>;

export function createAuthorizedRunContextResolver(options: {
  resolveSessionScope(
    principal: AgentRunPrincipal,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<AgentSessionScope | null>;
}) {
  return async (
    principal: AgentRunPrincipal,
    request: Pick<
      RunCreateRequest,
      "canvasId" | "conversationId" | "sessionId"
    >,
    signal?: AbortSignal,
  ): Promise<AuthorizedAgentRunContext> => {
    let scope: AgentSessionScope | null;
    try {
      scope = await options.resolveSessionScope(
        principal,
        request.sessionId,
        signal,
      );
    } catch (error) {
      if (error instanceof AgentRunError) throw error;
      throw contextUnavailable(error);
    }

    if (
      !scope ||
      !isCompleteScope(scope) ||
      scope.canvasId !== request.canvasId ||
      scope.sessionId !== request.sessionId
    ) {
      throw contextForbidden();
    }

    return Object.freeze({
      ...scope,
      ...principal,
      conversationId: request.conversationId,
    });
  };
}

function isCompleteScope(scope: AgentSessionScope): boolean {
  return [
    scope.canvasId,
    scope.projectId,
    scope.sessionId,
    scope.threadId,
    scope.workspaceId,
  ].every((value) => value.trim().length > 0);
}

function contextForbidden(): AgentRunError {
  return new AgentRunError({
    code: "agent_context_forbidden",
    statusCode: 403,
    message: "You do not have access to this Agent context.",
    retryable: false,
  });
}

function contextUnavailable(cause: unknown): AgentRunError {
  return new AgentRunError({
    code: "agent_context_unavailable",
    statusCode: 503,
    message: "Agent context is temporarily unavailable.",
    retryable: true,
    cause,
  });
}

export type ResolveAuthorizedRunContext = ReturnType<
  typeof createAuthorizedRunContextResolver
>;
