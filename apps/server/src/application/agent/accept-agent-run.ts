import { createHash, randomUUID } from "node:crypto";

import type { RunCreateRequest } from "@loomic/shared";

import type { AgentAuthority } from "../../agent/capabilities.js";
import { freezeExecutionContext } from "../../agent/execution-context.js";
import type { AgentExecutionRepository } from "../../features/agent-runs/agent-execution-repository.js";
import type { AuthorizedAgentRunContext } from "./authorized-run-context.js";

interface SkillCatalogView {
  readonly digest: string;
  list(): readonly {
    readonly name: string;
    readonly requiredCapabilities: readonly string[];
  }[];
}

export type AcceptedAgentRun = Readonly<{
  created: boolean;
  requestDigest: string;
  runId: string;
  status: "accepted";
}>;

export type AcceptAgentRunInput = Readonly<{
  context: AuthorizedAgentRunContext;
  model?: string;
  request: RunCreateRequest;
  requestDigest: string;
  signal?: AbortSignal;
}>;

export function createAcceptAgentRun(options: {
  readonly repository: AgentExecutionRepository;
  readonly catalog: SkillCatalogView;
  readonly resolveAuthority: (
    scope: Pick<
      AuthorizedAgentRunContext,
      "canvasId" | "projectId" | "workspaceId"
    >,
  ) => AgentAuthority;
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

  return async (input: AcceptAgentRunInput): Promise<AcceptedAgentRun> => {
    assertMatchingRequestContext(input.request, input.context);
    if (
      input.requestDigest !==
      createAgentRunRequestDigest(input.request, input.context)
    ) {
      throw new TypeError("agent_request_digest_mismatch");
    }

    const authority = options.resolveAuthority(input.context);
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
    const executionContext = freezeExecutionContext({
      attemptId: attemptIdFactory(),
      canvasId: input.context.canvasId,
      capabilities: [...authority.capabilities],
      capabilityPolicyVersion: authority.policyVersion,
      effectiveSkillNames,
      projectId: input.context.projectId,
      runId: runIdFactory(),
      skillCatalogDigest: options.catalog.digest,
      userId: input.context.userId,
      workspaceId: input.context.workspaceId,
    });
    const accepted = await options.repository.accept(
      {
        clientRequestId: input.request.clientRequestId,
        context: executionContext,
        sessionId: input.context.sessionId,
        threadId: input.context.threadId,
        ...(input.model ? { model: input.model } : {}),
        requestDigest: input.requestDigest,
      },
      input.signal,
    );
    options.onAccepted?.({
      runId: accepted.runId,
      canvasId: executionContext.canvasId,
      projectId: executionContext.projectId,
      workspaceId: executionContext.workspaceId,
      capabilities: executionContext.capabilities,
      effectiveSkillNames: executionContext.effectiveSkillNames,
      created: accepted.created,
    });
    return {
      created: accepted.created,
      requestDigest: input.requestDigest,
      runId: accepted.runId,
      status: "accepted",
    };
  };
}

export function createAgentRunRequestDigest(
  request: RunCreateRequest,
  context: AuthorizedAgentRunContext,
): string {
  const { accessToken: _ignoredAccessToken, ...requestWithoutAccessToken } =
    request;
  return createHash("sha256")
    .update(
      stableJson({
        request: requestWithoutAccessToken,
        scope: {
          canvasId: context.canvasId,
          projectId: context.projectId,
          sessionId: context.sessionId,
          threadId: context.threadId,
          workspaceId: context.workspaceId,
        },
        userId: context.userId,
      }),
    )
    .digest("hex");
}

function assertMatchingRequestContext(
  request: RunCreateRequest,
  context: AuthorizedAgentRunContext,
): void {
  if (
    request.canvasId !== context.canvasId ||
    request.conversationId !== context.conversationId ||
    request.sessionId !== context.sessionId
  ) {
    throw new TypeError("agent_request_context_mismatch");
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export type AcceptAgentRun = ReturnType<typeof createAcceptAgentRun>;
