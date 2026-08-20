import { describe, expect, it } from "vitest";

import type { ChatMessage } from "@loomic/shared";
import { deduplicateAdjacentMessages } from "./chat-service.js";

const timestamp = "2026-08-20T00:00:00.000Z";

describe("deduplicateAdjacentMessages", () => {
  it("keeps the adjacent duplicate with richer terminal lifecycle state", () => {
    const messages: ChatMessage[] = [
      {
        id: "legacy-assistant",
        role: "assistant",
        content: "Generated media.",
        createdAt: timestamp,
        contentBlocks: [
          { type: "text", text: "Generated media." },
          {
            type: "tool",
            toolCallId: "tool-1",
            toolName: "generate_image",
            status: "running",
          },
        ],
      },
      {
        id: "server-assistant",
        role: "assistant",
        content: "Generated media.",
        createdAt: timestamp,
        contentBlocks: [
          { type: "text", text: "Generated media." },
          {
            type: "tool",
            toolCallId: "tool-1",
            toolName: "generate_image",
            status: "completed",
            artifacts: [
              {
                type: "image",
                source: {
                  kind: "external",
                  url: "https://example.com/generated.png",
                },
                url: "https://example.com/generated.png",
                mimeType: "image/png",
                width: 512,
                height: 512,
              },
            ],
          },
        ],
      },
      {
        id: "user-message",
        role: "user",
        content: "Next request.",
        createdAt: timestamp,
        contentBlocks: [{ type: "text", text: "Next request." }],
      },
    ];

    expect(deduplicateAdjacentMessages(messages)).toEqual([
      messages[1],
      messages[2],
    ]);
  });

  it("keeps the earlier duplicate when lifecycle richness is identical", () => {
    const messages: ChatMessage[] = [
      {
        id: "earlier",
        role: "assistant",
        content: "Same content.",
        createdAt: timestamp,
        contentBlocks: [{ type: "text", text: "Same content." }],
      },
      {
        id: "later",
        role: "assistant",
        content: "Same content.",
        createdAt: timestamp,
        contentBlocks: [{ type: "text", text: "Same content." }],
      },
    ];

    expect(deduplicateAdjacentMessages(messages)).toEqual([messages[0]]);
  });

  it("uses artifacts and block count as lifecycle richness tiebreakers", () => {
    const messages: ChatMessage[] = [
      {
        id: "artifact-poor",
        role: "assistant",
        content: "With artifact.",
        createdAt: timestamp,
        contentBlocks: [
          {
            type: "tool",
            toolCallId: "tool-1",
            toolName: "generate_image",
            status: "completed",
          },
        ],
      },
      {
        id: "artifact-rich",
        role: "assistant",
        content: "With artifact.",
        createdAt: timestamp,
        contentBlocks: [
          {
            type: "tool",
            toolCallId: "tool-1",
            toolName: "generate_image",
            status: "completed",
            artifacts: [
              {
                type: "image",
                source: {
                  kind: "external",
                  url: "https://example.com/generated.png",
                },
                url: "https://example.com/generated.png",
                mimeType: "image/png",
                width: 512,
                height: 512,
              },
            ],
          },
        ],
      },
      {
        id: "separator",
        role: "user",
        content: "Next request.",
        createdAt: timestamp,
        contentBlocks: [{ type: "text", text: "Next request." }],
      },
      {
        id: "block-poor",
        role: "assistant",
        content: "Detailed response.",
        createdAt: timestamp,
        contentBlocks: [{ type: "text", text: "Detailed response." }],
      },
      {
        id: "block-rich",
        role: "assistant",
        content: "Detailed response.",
        createdAt: timestamp,
        contentBlocks: [
          { type: "text", text: "Detailed response." },
          { type: "thinking", thinking: "Stored additional context." },
        ],
      },
    ];

    expect(deduplicateAdjacentMessages(messages)).toEqual([
      messages[1],
      messages[2],
      messages[4],
    ]);
  });
});
