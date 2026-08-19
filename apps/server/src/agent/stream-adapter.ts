import type { AIMessage, AIMessageChunk } from "@langchain/core/messages";
import {
  AIMessageChunk as AIMessageChunkClass,
  AIMessage as AIMessageClass,
} from "@langchain/core/messages";

import type { StreamEvent } from "@loomic/shared";

import { sanitizeErrorForClient } from "../utils/error-sanitizer.js";
import type { ToolExecutionSupervisor } from "./tool-execution-supervisor.js";
import {
  type CanonicalToolRecord,
  canonicalToolRecordSchema,
} from "./tool-lifecycle.js";

/**
 * Shape of a LangChain v2 stream event from `streamEvents()`.
 */
type LangChainStreamEvent = {
  event: string;
  name?: string;
  data?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  run_id?: string;
  tags?: string[];
};

type AdaptDeepAgentStreamOptions = {
  conversationId: string;
  now?: () => string;
  runId: string;
  sessionId: string;
  signal?: AbortSignal;
  stream: AsyncIterable<LangChainStreamEvent | unknown>;
  supervisor: ToolExecutionSupervisor;
};

export async function* adaptDeepAgentStream(
  options: AdaptDeepAgentStreamOptions,
): AsyncGenerator<StreamEvent> {
  const now = options.now ?? (() => new Date().toISOString());
  const seenStreamedMessageIds = new Set<string>();

  yield {
    conversationId: options.conversationId,
    runId: options.runId,
    sessionId: options.sessionId,
    timestamp: now(),
    type: "run.started",
  };

  if (options.signal?.aborted) {
    yield canceledEvent(options.runId, now);
    return;
  }

  try {
    for await (const rawEvent of options.stream) {
      if (options.signal?.aborted) {
        yield canceledEvent(options.runId, now);
        return;
      }

      if (!isStreamEvent(rawEvent)) {
        continue;
      }

      const evt = rawEvent;

      if (evt.event === "on_custom_event") {
        if (!evt.name?.startsWith("loomic.tool.")) continue;
        const record = canonicalToolRecordSchema.parse(evt.data);
        if (options.supervisor.projectionStatus(record) === "projected") {
          options.supervisor.acknowledge(record);
          continue;
        }
        yield toPublicToolEvent(record);
        options.supervisor.acknowledge(record);
        continue;
      }

      // Per-token streaming from the chat model
      if (evt.event === "on_chat_model_stream") {
        const chunk = evt.data?.chunk;
        if (!chunk) continue;

        // Skip chunks that are tool calls (no text to emit)
        if (
          AIMessageChunkClass.isInstance(chunk) ||
          AIMessageClass.isInstance(chunk)
        ) {
          const msg = chunk as AIMessageChunk | AIMessage;
          if ((msg.tool_calls?.length ?? 0) > 0) continue;
        }

        const messageId =
          (chunk as { id?: string }).id ?? `message_${options.runId}`;

        const content = (chunk as { content: unknown }).content;

        // Handle array content (e.g. Gemini thinking + text blocks)
        if (Array.isArray(content)) {
          for (const part of content) {
            if (
              part &&
              typeof part === "object" &&
              "type" in part &&
              part.type === "thinking" &&
              "thinking" in part &&
              typeof part.thinking === "string" &&
              part.thinking
            ) {
              yield {
                type: "thinking.delta" as const,
                runId: options.runId,
                messageId,
                delta: part.thinking,
                timestamp: now(),
              };
            } else {
              const text =
                typeof part === "string"
                  ? part
                  : part &&
                      typeof part === "object" &&
                      "text" in part &&
                      typeof (part as { text: unknown }).text === "string"
                    ? (part as { text: string }).text
                    : "";
              if (text) {
                seenStreamedMessageIds.add(messageId);
                yield {
                  type: "message.delta" as const,
                  runId: options.runId,
                  messageId,
                  delta: text,
                  timestamp: now(),
                };
              }
            }
          }
          continue;
        }

        // String content (normal text)
        const delta = extractChunkText(chunk);
        if (!delta) continue;

        seenStreamedMessageIds.add(messageId);
        yield {
          delta,
          messageId,
          runId: options.runId,
          timestamp: now(),
          type: "message.delta",
        };
        continue;
      }

      // Fallback: complete message from non-streaming model (on_chat_model_end)
      if (evt.event === "on_chat_model_end") {
        const output = evt.data?.output;
        if (!output) continue;

        if (
          AIMessageClass.isInstance(output) ||
          AIMessageChunkClass.isInstance(output)
        ) {
          const msg = output as AIMessage | AIMessageChunk;
          const messageId = msg.id ?? `message_${options.runId}`;

          // Skip if this was a tool call message (tool lifecycle via on_tool_*)
          if ((msg.tool_calls?.length ?? 0) > 0) continue;
          if (seenStreamedMessageIds.has(messageId)) continue;

          const delta = extractChunkText(msg);
          if (!delta) continue;

          yield {
            delta,
            messageId,
            runId: options.runId,
            timestamp: now(),
            type: "message.delta",
          };
        }
        continue;
      }

      // Native tool events are tracing-only. Public lifecycles come from the
      // canonical Loomic middleware events handled above.
    }
  } catch (error) {
    if (isAbortError(error) || options.signal?.aborted) {
      yield canceledEvent(options.runId, now);
      return;
    }

    if (isToolLifecycleProtocolError(error)) throw error;

    // Log full error detail server-side
    console.error(
      `[stream-adapter] Stream error for run ${options.runId}:`,
      error,
    );

    yield {
      error: {
        code: "run_failed",
        message: sanitizeErrorForClient(error),
      },
      runId: options.runId,
      timestamp: now(),
      type: "run.failed",
    };
    return;
  }

  yield {
    runId: options.runId,
    timestamp: now(),
    type: "run.completed",
  };
}

export function toPublicToolEvent(record: CanonicalToolRecord): StreamEvent {
  switch (record.type) {
    case "loomic.tool.started":
      return {
        type: "tool.started",
        runId: record.agentRunId,
        toolCallId: record.logicalToolCallId,
        toolName: record.toolName,
        ...(record.input ? { input: record.input } : {}),
        timestamp: record.timestamp,
      };
    case "loomic.tool.completed":
      return {
        type: "tool.completed",
        runId: record.agentRunId,
        toolCallId: record.logicalToolCallId,
        toolName: record.toolName,
        ...(record.output ? { output: record.output } : {}),
        ...(record.outputSummary
          ? { outputSummary: record.outputSummary }
          : {}),
        ...(record.artifacts ? { artifacts: record.artifacts } : {}),
        timestamp: record.timestamp,
      };
    case "loomic.tool.failed":
      return {
        type: "tool.failed",
        runId: record.agentRunId,
        toolCallId: record.logicalToolCallId,
        toolName: record.toolName,
        error: record.error,
        timestamp: record.timestamp,
      };
  }
}

function isToolLifecycleProtocolError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("tool_lifecycle_");
}

function canceledEvent(runId: string, now: () => string): StreamEvent {
  return {
    runId,
    timestamp: now(),
    type: "run.canceled",
  };
}

/**
 * Extract text from a chat model stream chunk.
 */
function extractChunkText(chunk: unknown): string {
  if (!chunk || typeof chunk !== "object") return "";

  // AIMessageChunk / AIMessage with string content
  if ("content" in chunk) {
    const content = (chunk as { content: unknown }).content;
    if (typeof content === "string") return content;

    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part === "string") return part;
          if (
            part &&
            typeof part === "object" &&
            "text" in part &&
            typeof part.text === "string"
          ) {
            return part.text;
          }
          return "";
        })
        .join("");
    }
  }

  return "";
}

function isAbortError(error: unknown) {
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      error.message === "This operation was aborted")
  );
}

function isStreamEvent(value: unknown): value is LangChainStreamEvent {
  return (
    value !== null &&
    typeof value === "object" &&
    "event" in value &&
    typeof (value as { event: unknown }).event === "string"
  );
}
