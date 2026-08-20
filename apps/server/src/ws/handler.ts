import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";

import {
  type RunCreateRequest,
  wsCommandSchema,
  wsRpcResponseSchema,
} from "@loomic/shared";
import type { ContentBlock, StreamEvent, ToolBlock } from "@loomic/shared";
import type { AgentRunService } from "../agent/runtime.js";
import { AgentRunError } from "../application/agent/agent-run-errors.js";
import type {
  AgentRunStageLogger,
  PrepareAgentRun,
} from "../application/agent/prepare-agent-run.js";
import {
  AgentFinalizationUnconfirmedError,
  type AgentRunMetadataService,
} from "../features/agent-runs/agent-run-service.js";
import type { ChatService } from "../features/chat/chat-service.js";
import {
  type ResourceAuthorization,
  ResourceAuthorizationError,
  requireRunResourceAccess,
} from "../security/resource-authorization.js";
import {
  WsBudgetError,
  WsCommandBudget,
} from "../security/ws-command-budget.js";
import type {
  AuthenticatedUser,
  RequestAuthenticator,
} from "../supabase/user.js";
import type { ConnectionManager } from "./connection-manager.js";
import type { CanvasEventBuffer } from "./event-buffer.js";
import { createPipelineLogger } from "./logger.js";

type RegisterWsOptions = {
  agentRuns: AgentRunService;
  agentRunStageLogger?: AgentRunStageLogger;
  authorization: ResourceAuthorization;
  agentRunMetadataService?: AgentRunMetadataService;
  auth?: RequestAuthenticator;
  chatService?: ChatService;
  connectionManager: ConnectionManager;
  eventBuffer?: CanvasEventBuffer;
  prepareAgentRun?: PrepareAgentRun;
};

export async function registerWsRoute(
  app: FastifyInstance,
  options: RegisterWsOptions,
) {
  const { agentRuns, connectionManager } = options;

  app.get(
    "/api/ws",
    { websocket: true },
    (socket: WebSocket, request: FastifyRequest) => {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const token = url.searchParams.get("token");

      if (!token || !options.auth) {
        socket.close(4001, "Unauthorized");
        return;
      }

      void bindAuthenticatedSocket(socket, token, request, options);
    },
  );
}

export async function bindAuthenticatedSocket(
  socket: WebSocket,
  token: string,
  _request: FastifyRequest,
  options: RegisterWsOptions,
) {
  const { agentRuns, connectionManager } = options;
  const log = createPipelineLogger("ws");
  const commandBudget = new WsCommandBudget();
  let budgetViolations = 0;

  let authenticatedUser: AuthenticatedUser;
  try {
    const fakeRequest = {
      headers: { authorization: `Bearer ${token}` },
    } as unknown as FastifyRequest;
    const user = await options.auth!.authenticate(fakeRequest);
    if (!user) {
      log.warn("auth_rejected", { reason: "invalid_token" });
      socket.close(4001, "Unauthorized");
      return;
    }
    authenticatedUser = user;
    log.info("connected", { userId: user.id });
  } catch (err) {
    log.warn("auth_error", {
      error: err instanceof Error ? err.message : String(err),
    });
    socket.close(4001, "Unauthorized");
    return;
  }

  if (socket.readyState !== 1) return;

  // Use client-provided connectionId for reconnect identity; fallback to server UUID
  const urlForParams = new URL(_request.url, `http://${_request.headers.host}`);
  const requestedConnectionId = urlForParams.searchParams.get("connectionId");
  let connectionId = requestedConnectionId || randomUUID();
  if (!connectionManager.register(connectionId, authenticatedUser.id, socket)) {
    connectionId = randomUUID();
    connectionManager.register(connectionId, authenticatedUser.id, socket);
    log.warn("connection_id_conflict", {
      requestedConnectionId,
      userId: authenticatedUser.id,
    });
  }

  // Heartbeat with pong timeout (spec §1.3: 60s no-pong → disconnect)
  let lastPong = Date.now();
  socket.on("pong", () => {
    lastPong = Date.now();
  });

  const pingInterval = setInterval(() => {
    if (Date.now() - lastPong > 60_000) {
      log.warn("pong_timeout", { userId: authenticatedUser.id });
      socket.terminate();
      return;
    }
    if (socket.readyState === 1) {
      socket.ping();
    }
  }, 30_000);

  socket.on("message", (raw: Buffer | string) => {
    try {
      commandBudget.consumeMessage(Buffer.byteLength(raw));
    } catch (error) {
      budgetViolations += 1;
      sendCommandError(socket, error);
      log.warn("command_budget_exceeded", {
        code: error instanceof WsBudgetError ? error.code : "unknown",
        userId: authenticatedUser.id,
        violations: budgetViolations,
      });
      if (budgetViolations >= 3) {
        socket.close(4008, "Rate limit exceeded");
      }
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(
        typeof raw === "string" ? raw : raw.toString("utf-8"),
      );
    } catch {
      socket.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    const obj = parsed as Record<string, unknown>;

    if (obj.type === "rpc.response") {
      try {
        const rpcResponse = wsRpcResponseSchema.parse(parsed);
        connectionManager.handleRpcResponse(connectionId, {
          type: rpcResponse.type,
          id: rpcResponse.id,
          ...(rpcResponse.result !== undefined
            ? { result: rpcResponse.result }
            : {}),
          ...(rpcResponse.error !== undefined
            ? { error: rpcResponse.error }
            : {}),
        });
      } catch {
        // Ignore malformed RPC responses
      }
      return;
    }

    if (obj.type === "command") {
      let msg;
      try {
        msg = wsCommandSchema.parse(parsed);
      } catch {
        socket.send(
          JSON.stringify({ type: "error", message: "Invalid command format" }),
        );
        return;
      }

      if (msg.action === "agent.run") {
        const p = msg.payload;
        const runToken = p.accessToken ?? token;
        try {
          commandBudget.startAgentRun();
        } catch (error) {
          sendCommandError(socket, error);
          return;
        }
        void handleRunCommand(
          {
            ...authenticatedUser,
            accessToken: runToken,
          },
          connectionId,
          {
            sessionId: p.sessionId,
            conversationId: p.conversationId,
            prompt: p.prompt,
            canvasId: p.canvasId,
            clientRequestId: p.clientRequestId,
            ...(p.attachments !== undefined
              ? { attachments: p.attachments }
              : {}),
            ...(p.imageGenerationPreference !== undefined
              ? { imageGenerationPreference: p.imageGenerationPreference }
              : {}),
            ...(p.videoGenerationPreference !== undefined
              ? { videoGenerationPreference: p.videoGenerationPreference }
              : {}),
            ...(p.mentions !== undefined ? { mentions: p.mentions } : {}),
            ...(p.model !== undefined ? { model: p.model } : {}),
          },
          _request.id ?? connectionId,
          agentRuns,
          connectionManager,
          options,
        )
          .catch((error) =>
            sendCommandError(socket, error, {
              action: "agent.run",
              clientRequestId: p.clientRequestId,
            }),
          )
          .finally(() => commandBudget.finishAgentRun());
      } else if (msg.action === "agent.cancel") {
        void (async () => {
          await authorizeRunCancel(
            options.authorization,
            authenticatedUser,
            msg.payload.runId,
          );
          log.info("run_cancel", {
            userId: authenticatedUser.id,
            runId: msg.payload.runId,
          });
          const cancelResult = await agentRuns.cancelRun(msg.payload.runId);
          if (!cancelResult) {
            socket.send(
              JSON.stringify({ type: "error", message: "Run not found" }),
            );
          }
        })().catch((error) => sendCommandError(socket, error));
      } else if (msg.action === "canvas.resume") {
        const p = msg.payload;
        void (async () => {
          await authorizeCanvasResume(
            options.authorization,
            authenticatedUser,
            p.canvasId,
          );
          log.info("canvas_resume", {
            userId: authenticatedUser.id,
            canvasId: p.canvasId,
            lastSeq: p.lastSeq,
          });

          // Re-bind only after authorization so replay data never crosses tenants.
          connectionManager.bindCanvas(connectionId, p.canvasId);

          const missed =
            options.eventBuffer?.getAfter(p.canvasId, p.lastSeq) ?? [];
          const activeRun = connectionManager.getActiveRun(p.canvasId);

          // IMPORTANT: Send ACK FIRST so client registers event listener
          // BEFORE replay events arrive. Otherwise replayed events have no handler.
          connectionManager.sendTo(connectionId, {
            type: "command.ack",
            action: "canvas.resume",
            payload: {
              canvasId: p.canvasId,
              latestSeq: options.eventBuffer?.getLatestSeq(p.canvasId) ?? 0,
              activeRunId: activeRun?.runId ?? null,
              replayed: missed.length,
            },
          });

          // THEN replay missed events from buffer
          for (const entry of missed) {
            connectionManager.sendTo(connectionId, {
              type: "event",
              event: entry.event,
            });
          }
        })().catch((error) => sendCommandError(socket, error));
      }
    }
  });

  socket.on("close", () => {
    log.info("disconnected", { userId: authenticatedUser.id, connectionId });
    clearInterval(pingInterval);
    connectionManager.remove(connectionId);
  });

  socket.on("error", () => {
    log.error("socket_error", { userId: authenticatedUser.id, connectionId });
    clearInterval(pingInterval);
    connectionManager.remove(connectionId);
  });
}

async function handleRunCommand(
  authenticatedUser: AuthenticatedUser,
  connectionId: string,
  payload: Omit<RunCreateRequest, "accessToken">,
  requestId: string,
  agentRuns: AgentRunService,
  connectionManager: ConnectionManager,
  services: RegisterWsOptions,
) {
  const log = createPipelineLogger("agent.run", {
    userId: authenticatedUser.id,
    sessionId: payload.sessionId,
  });
  if (!services.prepareAgentRun) {
    throw new Error("Agent preparation is not configured.");
  }
  const prepared = await services.prepareAgentRun(
    payload,
    {
      accessToken: authenticatedUser.accessToken,
      userId: authenticatedUser.id,
    },
    { requestId },
  );
  const canvasId = prepared.context.canvasId;
  log.info("started", {
    canvasId: payload.canvasId,
    clientRequestId: payload.clientRequestId,
  });

  const registration = agentRuns.registerRun(payload, {
    accessToken: authenticatedUser.accessToken,
    durableCreated: prepared.accepted.created,
    runId: prepared.accepted.runId,
    userId: authenticatedUser.id,
    ...(prepared.model ? { model: prepared.model } : {}),
    threadId: prepared.context.threadId,
  });
  const response = registration.response;
  const runId = response.runId;
  log.lap("run_created", { runId });

  // Bind this connection to the canvas so events route correctly
  connectionManager.bindCanvas(connectionId, canvasId);
  if (registration.ownership !== "existing_active") {
    connectionManager.setActiveRun(canvasId, runId);
  }

  // Send ACK to the specific connection that initiated the run.
  // Retry with short delays if the connection is temporarily unavailable
  // (e.g., brief disconnect/reconnect during page transitions).
  const ackMessage = {
    type: "command.ack",
    action: "agent.run",
    payload: { ...response, clientRequestId: payload.clientRequestId },
  };
  const ackStartedAt = Date.now();
  let ackSent = connectionManager.sendTo(connectionId, ackMessage);
  if (!ackSent) {
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 500));
      ackSent = connectionManager.sendTo(connectionId, ackMessage);
      if (ackSent) break;
    }
  }
  const ackLogContext = {
    canvasId,
    clientRequestId: payload.clientRequestId,
    durationMs: Math.max(0, Date.now() - ackStartedAt),
    requestId,
    runId,
    sessionId: payload.sessionId,
  };
  if (ackSent) {
    services.agentRunStageLogger?.info("agent.ack.completed", ackLogContext);
  } else {
    services.agentRunStageLogger?.warn("agent.ack.failed", {
      ...ackLogContext,
      errorCode: "agent_ack_delivery_failed",
      retryable: true,
    });
  }
  log.lap("ack_sent", { runId, connectionId, delivered: ackSent });

  if (registration.ownership === "existing_active") return;

  const keepAlive = setInterval(() => {
    connectionManager.sendTo(connectionId, { type: "keep-alive" });
  }, 15_000);

  // Accumulate assistant content blocks for server-side persistence
  const assistantText: string[] = [];
  const assistantBlocks: ContentBlock[] = [];
  const deferredTerminalEvents: StreamEvent[] = [];

  const publishStreamEvent = (event: StreamEvent) => {
    services.eventBuffer?.push(canvasId, event);
    connectionManager.pushToCanvas(canvasId, event);
  };

  try {
    let firstEvent = true;
    for await (const event of agentRuns.streamRun(runId)) {
      if (firstEvent) {
        log.lap("first_token", { runId });
        firstEvent = false;
      }

      // Terminal events are published only after assistant persistence. This
      // keeps an actionable persistence-exhaustion marker ahead of client cleanup.
      if (isTerminalRunEvent(event)) {
        deferredTerminalEvents.push(event);
      } else {
        publishStreamEvent(event);
      }

      // Accumulate content for server-side persistence
      if (event.type === "message.delta") {
        appendTextBlock(assistantBlocks, event.delta);
        assistantText.push(event.delta);
      } else if (event.type === "thinking.delta") {
        appendThinkingBlock(assistantBlocks, event.delta);
      } else if (event.type === "run.failed" && assistantText.length === 0) {
        appendTextBlock(assistantBlocks, RUN_FAILURE_MESSAGE);
        assistantText.push(RUN_FAILURE_MESSAGE);
      } else if (event.type === "tool.started") {
        assistantBlocks.push({
          type: "tool",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          status: "running" as const,
          ...(event.input ? { input: event.input } : {}),
        });
      } else if (event.type === "tool.completed") {
        upsertTerminalToolBlock(assistantBlocks, {
          type: "tool",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          status: "completed",
          ...(event.output ? { output: event.output } : {}),
          ...(event.outputSummary
            ? { outputSummary: event.outputSummary }
            : {}),
          ...(event.artifacts ? { artifacts: event.artifacts } : {}),
        });
      } else if (event.type === "tool.failed") {
        upsertTerminalToolBlock(assistantBlocks, {
          type: "tool",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          status: "failed",
          error: event.error,
          ...(event.recovery ? { recovery: event.recovery } : {}),
          ...(event.artifacts ? { artifacts: event.artifacts } : {}),
        });
      }
    }
    log.lap("stream_done", { runId });

    // ── Server-side assistant message persistence ──
    if (
      services.chatService &&
      (assistantText.length > 0 || assistantBlocks.length > 0)
    ) {
      const message = {
        role: "assistant" as const,
        content: assistantText.join(""),
        contentBlocks: assistantBlocks,
      };
      const persisted = await persistAssistantMessage({
        chatService: services.chatService,
        input: message,
        log,
        sessionId: payload.sessionId,
        user: authenticatedUser,
      });
      if (persisted) {
        log.lap("assistant_message_persisted", { runId });
      } else {
        const failureMessage =
          "The assistant response could not be saved. Please retry.";
        log.error("assistant_message_persist_exhausted", {
          runId,
          errorCode: "assistant_message_persistence_failed",
        });
        connectionManager.sendTo(connectionId, {
          type: "error",
          action: "agent.run",
          clientRequestId: payload.clientRequestId,
          runId,
          error: {
            code: "assistant_message_persistence_failed",
            message: failureMessage,
          },
        });
        publishStreamEvent({
          type: "assistant.persistence_failed",
          runId,
          timestamp: new Date().toISOString(),
        });
      }
    }

    for (const event of deferredTerminalEvents) {
      publishStreamEvent(event);
    }
  } catch (error) {
    log.error("stream_error", {
      runId,
      error: error instanceof Error ? error.message : "unknown",
    });
    connectionManager.sendTo(connectionId, {
      type: "error",
      action: "agent.run",
      clientRequestId: payload.clientRequestId,
      runId,
      error:
        error instanceof AgentFinalizationUnconfirmedError
          ? {
              code: error.code,
              message: error.message,
              correlationId: error.correlationId,
            }
          : {
              code: "application_error",
              message: "Agent stream could not be completed.",
            },
    });
  } finally {
    clearInterval(keepAlive);
    connectionManager.clearActiveRun(canvasId);
  }
}

const MAX_PERSISTED_TOOL_ARTIFACTS = 10;
const ASSISTANT_PERSISTENCE_MAX_ATTEMPTS = 3;
const ASSISTANT_PERSISTENCE_RETRY_DELAY_MS = 25;
const RUN_FAILURE_MESSAGE = "抱歉，处理过程中遇到问题，请重试。";

async function persistAssistantMessage(options: {
  chatService: ChatService;
  input: { role: "assistant"; content: string; contentBlocks: ContentBlock[] };
  log: ReturnType<typeof createPipelineLogger>;
  sessionId: string;
  user: AuthenticatedUser;
}): Promise<boolean> {
  for (
    let attempt = 1;
    attempt <= ASSISTANT_PERSISTENCE_MAX_ATTEMPTS;
    attempt += 1
  ) {
    try {
      await options.chatService.createMessage(
        options.user,
        options.sessionId,
        options.input,
      );
      return true;
    } catch (error) {
      if (attempt === ASSISTANT_PERSISTENCE_MAX_ATTEMPTS) return false;
      options.log.warn("assistant_message_persist_retry", {
        attempt,
        error: boundedErrorMessage(error),
      });
      await new Promise((resolve) =>
        setTimeout(resolve, ASSISTANT_PERSISTENCE_RETRY_DELAY_MS * attempt),
      );
    }
  }
  return false;
}

function appendTextBlock(blocks: ContentBlock[], text: string): void {
  const lastBlock = blocks[blocks.length - 1];
  if (lastBlock?.type === "text") {
    lastBlock.text += text;
    return;
  }
  blocks.push({ type: "text", text });
}

function appendThinkingBlock(blocks: ContentBlock[], thinking: string): void {
  const lastBlock = blocks[blocks.length - 1];
  if (lastBlock?.type === "thinking") {
    lastBlock.thinking += thinking;
    return;
  }
  blocks.push({ type: "thinking", thinking });
}

function boundedErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 256) : "UnknownError";
}

function isTerminalRunEvent(event: StreamEvent): boolean {
  return (
    event.type === "run.completed" ||
    event.type === "run.failed" ||
    event.type === "run.canceled"
  );
}

function upsertTerminalToolBlock(
  blocks: ContentBlock[],
  terminal: ToolBlock,
): void {
  const boundedTerminal =
    terminal.artifacts &&
    terminal.artifacts.length > MAX_PERSISTED_TOOL_ARTIFACTS
      ? {
          ...terminal,
          artifacts: terminal.artifacts.slice(0, MAX_PERSISTED_TOOL_ARTIFACTS),
        }
      : terminal;
  const index = blocks.findIndex(
    (block) =>
      block.type === "tool" &&
      block.toolCallId === boundedTerminal.toolCallId,
  );
  if (index < 0) {
    blocks.push(boundedTerminal);
    return;
  }

  blocks[index] = {
    ...(blocks[index] as ToolBlock),
    ...boundedTerminal,
  };
}

export async function authorizeRunResources(
  authorization: ResourceAuthorization,
  user: AuthenticatedUser,
  payload: Pick<RunCreateRequest, "canvasId" | "conversationId" | "sessionId">,
): Promise<string> {
  return requireRunResourceAccess(authorization, user, payload);
}

export async function authorizeCanvasResume(
  authorization: ResourceAuthorization,
  user: AuthenticatedUser,
  canvasId: string,
): Promise<void> {
  await authorization.requireCanvasAccess(user, canvasId);
}

export async function authorizeRunCancel(
  authorization: ResourceAuthorization,
  user: AuthenticatedUser,
  runId: string,
): Promise<void> {
  await authorization.requireRunAccess(user, runId);
}

function sendCommandError(
  socket: WebSocket,
  error: unknown,
  correlation: { action?: string; clientRequestId?: string } = {},
) {
  const isForbidden = error instanceof ResourceAuthorizationError;
  const isBudgetError = error instanceof WsBudgetError;
  socket.send(
    JSON.stringify({
      type: "error",
      ...correlation,
      ...(error instanceof AgentRunError ? { retryable: error.retryable } : {}),
      error: {
        code:
          isForbidden || isBudgetError || error instanceof AgentRunError
            ? error.code
            : "application_error",
        message:
          isForbidden || isBudgetError || error instanceof AgentRunError
            ? error.message
            : "Command could not be completed.",
      },
    }),
  );
}
