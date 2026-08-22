import type { ContentBlock, StreamEvent } from "@loomic/shared";
import { describe, expect, it } from "vitest";

import { reduceAgentRunContent } from "../src/lib/agent-run-content";

describe("reduceAgentRunContent", () => {
  it("appends adjacent text and thinking deltas", () => {
    let blocks: ContentBlock[] = [];
    blocks = reduceAgentRunContent(blocks, {
      type: "message.delta",
      runId: "run-1",
      delta: "Hello",
    } as StreamEvent);
    blocks = reduceAgentRunContent(blocks, {
      type: "message.delta",
      runId: "run-1",
      delta: " world",
    } as StreamEvent);
    blocks = reduceAgentRunContent(blocks, {
      type: "thinking.delta",
      runId: "run-1",
      delta: "Checking",
    } as StreamEvent);

    expect(blocks).toEqual([
      { type: "text", text: "Hello world" },
      { type: "thinking", thinking: "Checking" },
    ]);
  });

  it("deduplicates tool starts and replaces them with terminal output", () => {
    const started = {
      type: "tool.started",
      runId: "run-1",
      toolCallId: "tool-1",
      toolName: "search",
      input: { query: "Loomic" },
    } as StreamEvent;
    let blocks = reduceAgentRunContent([], started);
    blocks = reduceAgentRunContent(blocks, started);
    blocks = reduceAgentRunContent(blocks, {
      type: "tool.completed",
      runId: "run-1",
      toolCallId: "tool-1",
      toolName: "search",
      outputSummary: "Found",
    } as StreamEvent);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: "tool",
      toolCallId: "tool-1",
      status: "completed",
      outputSummary: "Found",
    });
  });

  it("adds fallback text and completes running tools when a run fails", () => {
    const blocks = reduceAgentRunContent(
      [
        {
          type: "tool",
          toolCallId: "tool-1",
          toolName: "search",
          status: "running",
        },
      ],
      {
        type: "run.failed",
        runId: "run-1",
        error: { message: "failed" },
      } as StreamEvent,
    );

    expect(blocks[0]).toMatchObject({ type: "tool", status: "completed" });
    expect(blocks[1]).toMatchObject({ type: "text" });
  });

  it("completes running tools without adding fallback text when canceled", () => {
    const blocks = reduceAgentRunContent(
      [
        {
          type: "tool",
          toolCallId: "tool-1",
          toolName: "search",
          status: "running",
        },
      ],
      { type: "run.canceled", runId: "run-1" } as StreamEvent,
    );

    expect(blocks).toEqual([
      {
        type: "tool",
        toolCallId: "tool-1",
        toolName: "search",
        status: "completed",
      },
    ]);
  });
});
