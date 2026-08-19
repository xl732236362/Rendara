import type { RunCreateRequest } from "@loomic/shared";

import {
  AgentAcceptanceRepositoryError,
  type AgentExecutionRepository,
  type PersistedAgentAcceptance,
} from "../../features/agent-runs/agent-execution-repository.js";
import {
  type AcceptAgentRun,
  type AcceptedAgentRun,
  createAgentRunRequestDigest,
} from "./accept-agent-run.js";
import { AgentRunError, runWithDeadline } from "./agent-run-errors.js";
import type {
  AgentRunPrincipal,
  AuthorizedAgentRunContext,
  ResolveAuthorizedRunContext,
} from "./authorized-run-context.js";

export type AgentRunStageLogger = Readonly<{
  error(event: string, context: Record<string, unknown>): void;
  info(event: string, context: Record<string, unknown>): void;
  warn(event: string, context: Record<string, unknown>): void;
}>;

export type PreparedAgentRun = Readonly<{
  accepted: AcceptedAgentRun;
  context: AuthorizedAgentRunContext;
  model: string | undefined;
}>;

type PrepareMetadata = Readonly<{
  parentSignal?: AbortSignal;
  requestId?: string;
}>;

export function createPrepareAgentRun(options: {
  acceptAgentRun: AcceptAgentRun;
  acceptanceTimeoutMs?: number;
  contextTimeoutMs?: number;
  findAcceptance: AgentExecutionRepository["findAcceptance"];
  logger?: AgentRunStageLogger;
  modelTimeoutMs?: number;
  now?: () => number;
  reconcileTimeoutMs?: number;
  resolveContext: ResolveAuthorizedRunContext;
  resolveWorkspaceModel(
    context: AuthorizedAgentRunContext,
    signal?: AbortSignal,
  ): Promise<string | undefined>;
}) {
  const acceptanceTimeoutMs = options.acceptanceTimeoutMs ?? 4_000;
  const contextTimeoutMs = options.contextTimeoutMs ?? 4_000;
  const logger = options.logger ?? NOOP_LOGGER;
  const modelTimeoutMs = options.modelTimeoutMs ?? 2_000;
  const now = options.now ?? Date.now;
  const reconcileTimeoutMs = options.reconcileTimeoutMs ?? 2_000;

  return async (
    request: RunCreateRequest,
    principal: AgentRunPrincipal,
    metadata: PrepareMetadata = {},
  ): Promise<PreparedAgentRun> => {
    const baseLogContext = compact({
      canvasId: request.canvasId,
      clientRequestId: request.clientRequestId,
      requestId: metadata.requestId,
      sessionId: request.sessionId,
    });
    const contextStartedAt = now();
    logger.info("agent.context.resolve.started", baseLogContext);

    let context: AuthorizedAgentRunContext;
    try {
      context = await runWithDeadline({
        operation: (signal) =>
          options.resolveContext(principal, request, signal),
        ...(metadata.parentSignal
          ? { parentSignal: metadata.parentSignal }
          : {}),
        timeoutError: contextTimeoutError,
        timeoutMs: contextTimeoutMs,
      });
      logger.info("agent.context.resolve.completed", {
        ...baseLogContext,
        durationMs: elapsed(now, contextStartedAt),
        projectId: context.projectId,
        threadId: context.threadId,
        workspaceId: context.workspaceId,
      });
    } catch (error) {
      const failure = normalizeContextError(error);
      logger.warn("agent.context.resolve.failed", {
        ...baseLogContext,
        durationMs: elapsed(now, contextStartedAt),
        errorCode: failure.code,
        retryable: failure.retryable,
      });
      throw failure;
    }

    const model = await resolveModel({
      baseLogContext,
      context,
      logger,
      metadata,
      modelTimeoutMs,
      now,
      request,
      resolveWorkspaceModel: options.resolveWorkspaceModel,
    });
    const requestDigest = createAgentRunRequestDigest(request, context);
    const acceptStartedAt = now();
    logger.info("agent.accept.started", baseLogContext);

    try {
      const accepted = await runWithDeadline({
        operation: (signal) =>
          options.acceptAgentRun({
            context,
            ...(model ? { model } : {}),
            request,
            requestDigest,
            signal,
          }),
        ...(metadata.parentSignal
          ? { parentSignal: metadata.parentSignal }
          : {}),
        timeoutError: () => new AcceptanceDeadlineError(),
        timeoutMs: acceptanceTimeoutMs,
      });
      if (!accepted.created) {
        return await reconcile({
          acceptStartedAt,
          baseLogContext,
          context,
          logger,
          metadata,
          now,
          options,
          reconcileTimeoutMs,
          request,
          requestDigest,
        });
      }
      logger.info("agent.accept.completed", {
        ...baseLogContext,
        created: true,
        durationMs: elapsed(now, acceptStartedAt),
        runId: accepted.runId,
      });
      return { accepted, context, model };
    } catch (error) {
      if (shouldReconcile(error)) {
        logger.warn("agent.accept.failed", {
          ...baseLogContext,
          durationMs: elapsed(now, acceptStartedAt),
          errorCode: "agent_acceptance_indeterminate",
          retryable: true,
        });
        return await reconcile({
          acceptStartedAt,
          baseLogContext,
          context,
          logger,
          metadata,
          now,
          options,
          reconcileTimeoutMs,
          request,
          requestDigest,
        });
      }
      const failure = normalizeAcceptanceError(error);
      logger.warn("agent.accept.failed", {
        ...baseLogContext,
        durationMs: elapsed(now, acceptStartedAt),
        errorCode: failure.code,
        retryable: failure.retryable,
      });
      throw failure;
    }
  };
}

async function resolveModel(input: {
  baseLogContext: Record<string, unknown>;
  context: AuthorizedAgentRunContext;
  logger: AgentRunStageLogger;
  metadata: PrepareMetadata;
  modelTimeoutMs: number;
  now: () => number;
  request: RunCreateRequest;
  resolveWorkspaceModel(
    context: AuthorizedAgentRunContext,
    signal?: AbortSignal,
  ): Promise<string | undefined>;
}): Promise<string | undefined> {
  const startedAt = input.now();
  if (input.request.model) {
    input.logger.info("agent.model.resolve.completed", {
      ...input.baseLogContext,
      durationMs: elapsed(input.now, startedAt),
      source: "client",
      workspaceId: input.context.workspaceId,
    });
    return input.request.model;
  }

  try {
    const model = await runWithDeadline({
      operation: (signal) => input.resolveWorkspaceModel(input.context, signal),
      ...(input.metadata.parentSignal
        ? { parentSignal: input.metadata.parentSignal }
        : {}),
      timeoutError: contextTimeoutError,
      timeoutMs: input.modelTimeoutMs,
    });
    input.logger.info("agent.model.resolve.completed", {
      ...input.baseLogContext,
      durationMs: elapsed(input.now, startedAt),
      source: "workspace",
      workspaceId: input.context.workspaceId,
    });
    return model;
  } catch (error) {
    const failure = normalizeContextError(error);
    input.logger.warn("agent.model.resolve.failed", {
      ...input.baseLogContext,
      durationMs: elapsed(input.now, startedAt),
      errorCode: failure.code,
      retryable: failure.retryable,
      workspaceId: input.context.workspaceId,
    });
    return undefined;
  }
}

async function reconcile(input: {
  acceptStartedAt: number;
  baseLogContext: Record<string, unknown>;
  context: AuthorizedAgentRunContext;
  logger: AgentRunStageLogger;
  metadata: PrepareMetadata;
  now: () => number;
  options: {
    findAcceptance: AgentExecutionRepository["findAcceptance"];
  };
  reconcileTimeoutMs: number;
  request: RunCreateRequest;
  requestDigest: string;
}): Promise<PreparedAgentRun> {
  let persisted: PersistedAgentAcceptance | null;
  try {
    persisted = await runWithDeadline({
      operation: (signal) =>
        input.options.findAcceptance({
          clientRequestId: input.request.clientRequestId,
          signal,
          userId: input.context.userId,
        }),
      ...(input.metadata.parentSignal
        ? { parentSignal: input.metadata.parentSignal }
        : {}),
      timeoutError: acceptanceIndeterminateError,
      timeoutMs: input.reconcileTimeoutMs,
    });
  } catch {
    throw acceptanceIndeterminateError();
  }
  if (!persisted) throw acceptanceIndeterminateError();
  if (persisted.requestDigest !== input.requestDigest) {
    throw acceptanceConflictError();
  }

  const accepted: AcceptedAgentRun = {
    created: false,
    requestDigest: input.requestDigest,
    runId: persisted.runId,
    status: "accepted",
  };
  input.logger.info("agent.accept.completed", {
    ...input.baseLogContext,
    created: false,
    durationMs: elapsed(input.now, input.acceptStartedAt),
    reconciled: true,
    runId: persisted.runId,
  });
  return {
    accepted,
    context: input.context,
    model: persisted.model,
  };
}

class AcceptanceDeadlineError extends Error {
  constructor() {
    super("agent_acceptance_deadline");
    this.name = "AcceptanceDeadlineError";
  }
}

function shouldReconcile(error: unknown): boolean {
  return (
    error instanceof AcceptanceDeadlineError ||
    (error instanceof AgentAcceptanceRepositoryError &&
      error.kind === "indeterminate")
  );
}

function normalizeContextError(error: unknown): AgentRunError {
  if (error instanceof AgentRunError) return error;
  return new AgentRunError({
    code: "agent_context_unavailable",
    statusCode: 503,
    message: "Agent context is temporarily unavailable.",
    retryable: true,
    cause: error,
  });
}

function normalizeAcceptanceError(error: unknown): AgentRunError {
  if (error instanceof AgentRunError) return error;
  if (error instanceof AgentAcceptanceRepositoryError) {
    switch (error.kind) {
      case "conflict":
        return acceptanceConflictError();
      case "definitive_unavailable":
        return new AgentRunError({
          code: "agent_acceptance_unavailable",
          statusCode: 503,
          message: "Agent acceptance is temporarily unavailable.",
          retryable: true,
          cause: error,
        });
      case "definitive_failed":
        return acceptanceFailedError(error);
      case "indeterminate":
      case "lookup_unavailable":
        return acceptanceIndeterminateError();
    }
  }
  return acceptanceFailedError(error);
}

function contextTimeoutError(): AgentRunError {
  return new AgentRunError({
    code: "agent_context_timeout",
    statusCode: 504,
    message: "Agent context resolution timed out.",
    retryable: true,
  });
}

function acceptanceConflictError(): AgentRunError {
  return new AgentRunError({
    code: "agent_acceptance_conflict",
    statusCode: 409,
    message: "This request conflicts with an earlier Agent submission.",
    retryable: false,
  });
}

function acceptanceIndeterminateError(): AgentRunError {
  return new AgentRunError({
    code: "agent_acceptance_indeterminate",
    statusCode: 504,
    message: "Agent acceptance is still being confirmed.",
    retryable: true,
  });
}

function acceptanceFailedError(cause: unknown): AgentRunError {
  return new AgentRunError({
    code: "agent_acceptance_failed",
    statusCode: 500,
    message: "Agent acceptance failed.",
    retryable: false,
    cause,
  });
}

function compact(
  value: Record<string, string | undefined>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] =>
      Boolean(entry[1]),
    ),
  );
}

function elapsed(now: () => number, startedAt: number): number {
  return Math.max(0, now() - startedAt);
}

const NOOP_LOGGER: AgentRunStageLogger = Object.freeze({
  error: () => undefined,
  info: () => undefined,
  warn: () => undefined,
});

export type PrepareAgentRun = ReturnType<typeof createPrepareAgentRun>;
