import { createHash, randomUUID } from "node:crypto";

import type { RunCreateRequest } from "@loomic/shared";

import type { AgentAuthority } from "../../agent/capabilities.js";
import { freezeExecutionContext } from "../../agent/execution-context.js";
import type { AgentExecutionRepository } from "../../features/agent-runs/agent-execution-repository.js";

interface CanonicalScope {
  readonly canvasId: string;
  readonly projectId: string;
  readonly workspaceId: string;
}

interface AgentPrincipal {
  readonly userId: string;
  readonly accessToken?: string;
}

interface SkillCatalogView {
  readonly digest: string;
  list(): readonly {
    readonly name: string;
    readonly requiredCapabilities: readonly string[];
  }[];
}

export function createAcceptAgentRun(options: {
  readonly repository: AgentExecutionRepository;
  readonly catalog: SkillCatalogView;
  readonly resolveAuthority: (scope: CanonicalScope) => AgentAuthority;
  readonly resolveScope: (
    principal: AgentPrincipal,
    canvasId: string,
  ) => Promise<CanonicalScope>;
  readonly requireSessionScope: (
    principal: AgentPrincipal,
    sessionId: string,
  ) => Promise<Pick<CanonicalScope, "projectId" | "workspaceId">>;
  readonly runIdFactory?: () => string;
  readonly attemptIdFactory?: () => string;
  readonly onAccepted?: (event: {
    readonly runId: string;
    readonly canvasId: string;
    readonly projectId: string;
    readonly workspaceId: string;
    readonly capabilities: readonly string[];
    readonly effectiveSkillNames: readonly string[];
    readonly created: boolean;
  }) => void;
}) {
  const runIdFactory = options.runIdFactory ?? randomUUID;
  const attemptIdFactory = options.attemptIdFactory ?? randomUUID;

  return async (
    request: RunCreateRequest,
    principal: AgentPrincipal,
    metadata: { readonly threadId?: string; readonly model?: string } = {},
  ): Promise<{ runId: string; status: "accepted" }> => {
    const scope = await options.resolveScope(principal, request.canvasId);
    const sessionScope = await options.requireSessionScope(
      principal,
      request.sessionId,
    );
    if (
      scope.projectId !== sessionScope.projectId ||
      scope.workspaceId !== sessionScope.workspaceId
    ) {
      throw new Error("session_canvas_mismatch");
    }

    const authority = options.resolveAuthority(scope);
    const capabilitySet = new Set(authority.capabilities);
    const effectiveSkillNames = options.catalog
      .list()
      .filter(
        (skill) =>
          capabilitySet.has("skill.read") &&
          skill.requiredCapabilities.every((capability) =>
            capabilitySet.has(capability as never),
          ),
      )
      .map((skill) => skill.name)
      .sort();
    const context = freezeExecutionContext({
      attemptId: attemptIdFactory(),
      canvasId: scope.canvasId,
      capabilities: [...authority.capabilities],
      capabilityPolicyVersion: authority.policyVersion,
      effectiveSkillNames,
      projectId: scope.projectId,
      runId: runIdFactory(),
      skillCatalogDigest: options.catalog.digest,
      userId: principal.userId,
      workspaceId: scope.workspaceId,
    });
    const requestDigest = createHash("sha256")
      .update(
        JSON.stringify({
          request,
          scope,
          userId: principal.userId,
        }),
      )
      .digest("hex");
    const accepted = await options.repository.accept({
      clientRequestId: request.clientRequestId,
      context,
      sessionId: request.sessionId,
      threadId: metadata.threadId ?? request.sessionId,
      ...(metadata.model ? { model: metadata.model } : {}),
      requestDigest,
    });
    options.onAccepted?.({
      runId: accepted.runId,
      canvasId: context.canvasId,
      projectId: context.projectId,
      workspaceId: context.workspaceId,
      capabilities: context.capabilities,
      effectiveSkillNames: context.effectiveSkillNames,
      created: accepted.created,
    });
    return { runId: accepted.runId, status: "accepted" };
  };
}

export type AcceptAgentRun = ReturnType<typeof createAcceptAgentRun>;
