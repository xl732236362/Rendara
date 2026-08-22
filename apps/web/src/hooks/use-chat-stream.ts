"use client";

import { useCallback } from "react";

import type { StreamEvent } from "@loomic/shared";
import { reduceAgentRunContent } from "../lib/agent-run-content";
import type { Message } from "./use-chat-sessions";

type MessageUpdater = (
  targetSessionId: string,
  updater: (prev: Message[]) => Message[],
) => void;

/** Applies live Agent events through the shared run-content reducer. */
export function useChatStream(updateSessionMessages: MessageUpdater) {
  const applyStreamEvent = useCallback(
    (event: StreamEvent, assistantId: string, sessionId: string) => {
      if (!assistantId || !sessionId) {
        console.warn("[chat-stream] event_missing_owner", {
          assistantId,
          sessionId,
          eventType: event.type,
        });
        return;
      }

      updateSessionMessages(sessionId, (messages) =>
        messages.map((message) => {
          if (message.id !== assistantId) return message;
          const contentBlocks = reduceAgentRunContent(
            message.contentBlocks,
            event,
          );
          return contentBlocks === message.contentBlocks
            ? message
            : { ...message, contentBlocks };
        }),
      );
    },
    [updateSessionMessages],
  );

  return { applyStreamEvent };
}
