import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentAcceptanceRepositoryError } from "../../features/agent-runs/agent-execution-repository.js";
import { createAgentRunRequestDigest } from "./accept-agent-run.js";
import type { AuthorizedAgentRunContext } from "./authorized-run-context.js";
import { createPrepareAgentRun } from "./prepare-agent-run.js";

const principal = { accessToken: "sentinel-access-token", userId: "user-1" };

const request = {
  canvasId: "canvas-1",
  clientRequestId: "request-1",
  conversationId: "conversation-1",
  prompt: "sentinel private prompt",
  sessionId: "session-1",
};

const context: AuthorizedAgentRunContext = Object.freeze({
  ...principal,
  canvasId: "canvas-1",
  conversationId: "conversation-1",
  projectId: "project-1",
  sessionId: "session-1",
  threadId: "thread-1",
  workspaceId: "workspace-1",
});

afterEach(() => {
  vi.useRealTimers();
});

function createSubject(
  overrides: Partial<Parameters<typeof createPrepareAgentRun>[0]> = {},
) {
  const events: Array<{ event: string; context: Record<string, unknown> }> = [];
  const logger = {
    error: vi.fn((event: string, logContext: Record<string, unknown>) => {
      events.push({ event, context: logContext });
    }),
    info: vi.fn((event: string, logContext: Record<string, unknown>) => {
      events.push({ event, context: logContext });
    }),
    warn: vi.fn((event: string, logContext: Record<string, unknown>) => {
      events.push({ event, context: logContext });
    }),
  };
  const resolveContext = vi.fn(async () => context);
  const resolveWorkspaceModel = vi.fn(async () => "openai:workspace-model");
  const acceptAgentRun = vi.fn(async (input) => ({
    created: true,
    requestDigest: input.requestDigest,
    runId: "run-1",
    status: "accepted" as const,
  }));
  const findAcceptance = vi.fn(async () => null);
  const prepare = createPrepareAgentRun({
    acceptAgentRun,
    acceptanceTimeoutMs: 50,
    contextTimeoutMs: 50,
    findAcceptance,
    logger,
    modelTimeoutMs: 50,
    reconcileTimeoutMs: 50,
    resolveContext,
    resolveWorkspaceModel,
    ...overrides,
  });
  return {
    acceptAgentRun,
    events,
    findAcceptance,
    logger,
    prepare,
    resolveContext,
    resolveWorkspaceModel,
  };
}

describe("prepare Agent run", () => {
  it("resolves canonical context and its workspace model before acceptance", async () => {
    const subject = createSubject();

    await expect(
      subject.prepare(request, principal, { requestId: "req-1" }),
    ).resolves.toMatchObject({
      accepted: { created: true, runId: "run-1" },
      context,
      model: "openai:workspace-model",
    });
    expect(subject.resolveContext).toHaveBeenCalledOnce();
    expect(subject.resolveWorkspaceModel).toHaveBeenCalledWith(
      context,
      expect.any(AbortSignal),
    );
    expect(subject.acceptAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        context,
        model: "openai:workspace-model",
        request,
        requestDigest: createAgentRunRequestDigest(request, context),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("uses a client-selected model without reading workspace settings", async () => {
    const subject = createSubject();

    await expect(
      subject.prepare({ ...request, model: "openai:client-model" }, principal),
    ).resolves.toMatchObject({ model: "openai:client-model" });
    expect(subject.resolveWorkspaceModel).not.toHaveBeenCalled();
  });

  it("bounds context resolution and aborts the dependency", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const subject = createSubject({
      contextTimeoutMs: 5,
      resolveContext: vi.fn((_principal, _request, nextSignal) => {
        signal = nextSignal;
        return new Promise<never>(() => undefined);
      }),
    });
    const result = subject.prepare(request, principal);
    const rejection = expect(result).rejects.toMatchObject({
      code: "agent_context_timeout",
      retryable: true,
    });

    await vi.advanceTimersByTimeAsync(5);

    await rejection;
    expect(signal?.aborted).toBe(true);
  });

  it("falls back when workspace model resolution times out", async () => {
    vi.useFakeTimers();
    const subject = createSubject({
      modelTimeoutMs: 5,
      resolveWorkspaceModel: vi.fn(() => new Promise<never>(() => undefined)),
    });
    const result = subject.prepare(request, principal);

    await vi.advanceTimersByTimeAsync(5);

    await expect(result).resolves.toMatchObject({ model: undefined });
    expect(subject.acceptAgentRun).toHaveBeenCalledWith(
      expect.not.objectContaining({ model: expect.anything() }),
    );
    expect(subject.logger.warn).toHaveBeenCalledWith(
      "agent.model.resolve.failed",
      expect.objectContaining({ errorCode: "agent_context_timeout" }),
    );
  });

  it("reconciles a late acceptance and reuses its persisted model", async () => {
    vi.useFakeTimers();
    const requestDigest = createAgentRunRequestDigest(request, context);
    const subject = createSubject({
      acceptanceTimeoutMs: 5,
      acceptAgentRun: vi.fn(() => new Promise<never>(() => undefined)),
      findAcceptance: vi.fn(async () => ({
        model: "openai:original-model",
        requestDigest,
        runId: "run-existing",
      })),
    });
    const result = subject.prepare(request, principal);

    await vi.advanceTimersByTimeAsync(5);

    await expect(result).resolves.toMatchObject({
      accepted: { created: false, runId: "run-existing" },
      model: "openai:original-model",
    });
  });

  it("reconciles an indeterminate transport failure without waiting for a deadline", async () => {
    const requestDigest = createAgentRunRequestDigest(request, context);
    const subject = createSubject({
      acceptAgentRun: vi.fn(async () => {
        throw new AgentAcceptanceRepositoryError("indeterminate");
      }),
      findAcceptance: vi.fn(async () => ({
        requestDigest,
        runId: "run-existing",
      })),
    });

    await expect(subject.prepare(request, principal)).resolves.toMatchObject({
      accepted: { created: false, runId: "run-existing" },
    });
  });

  it("returns indeterminate when reconciliation cannot prove a commit", async () => {
    vi.useFakeTimers();
    const subject = createSubject({
      acceptanceTimeoutMs: 5,
      acceptAgentRun: vi.fn(() => new Promise<never>(() => undefined)),
      findAcceptance: vi.fn(async () => null),
    });
    const result = subject.prepare(request, principal);
    const rejection = expect(result).rejects.toMatchObject({
      code: "agent_acceptance_indeterminate",
      retryable: true,
    });

    await vi.advanceTimersByTimeAsync(5);

    await rejection;
  });

  it("rejects a reconciled digest mismatch as a terminal conflict", async () => {
    const subject = createSubject({
      acceptAgentRun: vi.fn(async () => {
        throw new AgentAcceptanceRepositoryError("indeterminate");
      }),
      findAcceptance: vi.fn(async () => ({
        requestDigest: "different-digest",
        runId: "run-existing",
      })),
    });

    await expect(subject.prepare(request, principal)).rejects.toMatchObject({
      code: "agent_acceptance_conflict",
      retryable: false,
    });
  });

  it("maps a definitive transient rollback without reconciliation", async () => {
    const findAcceptance = vi.fn(async () => null);
    const subject = createSubject({
      acceptAgentRun: vi.fn(async () => {
        throw new AgentAcceptanceRepositoryError("definitive_unavailable");
      }),
      findAcceptance,
    });

    await expect(subject.prepare(request, principal)).rejects.toMatchObject({
      code: "agent_acceptance_unavailable",
      retryable: true,
    });
    expect(findAcceptance).not.toHaveBeenCalled();
  });

  it("emits stage logs without prompts or credentials", async () => {
    const subject = createSubject();

    await subject.prepare(request, principal, { requestId: "req-safe" });

    const serialized = JSON.stringify(subject.events);
    expect(serialized).toContain("agent.context.resolve.completed");
    expect(serialized).toContain("agent.model.resolve.completed");
    expect(serialized).toContain("agent.accept.completed");
    expect(serialized).toContain("req-safe");
    expect(serialized).not.toContain("sentinel-access-token");
    expect(serialized).not.toContain("sentinel private prompt");
  });
});
