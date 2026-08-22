import type { ContentBlock, StreamEvent, ToolBlock } from "@loomic/shared";

export function reduceAgentRunContent(
  previous: ContentBlock[],
  event: StreamEvent,
): ContentBlock[] {
  switch (event.type) {
    case "message.delta": {
      if (event.delta === undefined || event.delta === null) return previous;
      const blocks = [...previous];
      const last = blocks.at(-1);
      if (last?.type === "text") {
        blocks[blocks.length - 1] = { ...last, text: last.text + event.delta };
      } else {
        blocks.push({ type: "text", text: event.delta });
      }
      return blocks;
    }
    case "thinking.delta": {
      if (event.delta === undefined || event.delta === null) return previous;
      const blocks = [...previous];
      const last = blocks.at(-1);
      if (last?.type === "thinking") {
        blocks[blocks.length - 1] = {
          ...last,
          thinking: last.thinking + event.delta,
        };
      } else {
        blocks.push({ type: "thinking", thinking: event.delta });
      }
      return blocks;
    }
    case "tool.started": {
      if (
        previous.some(
          (block) =>
            block.type === "tool" && block.toolCallId === event.toolCallId,
        )
      ) {
        return previous;
      }
      const block: ToolBlock = {
        type: "tool",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        status: "running",
        ...(event.input ? { input: event.input } : {}),
      };
      return [...previous, block];
    }
    case "tool.completed":
    case "tool.failed": {
      const block: ToolBlock =
        event.type === "tool.completed"
          ? {
              type: "tool",
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              status: "completed",
              ...(event.output ? { output: event.output } : {}),
              ...(event.outputSummary
                ? { outputSummary: event.outputSummary }
                : {}),
              ...(event.artifacts ? { artifacts: event.artifacts } : {}),
            }
          : {
              type: "tool",
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              status: "failed",
              outputSummary: event.error.message,
              error: event.error,
              ...(event.recovery ? { recovery: event.recovery } : {}),
              ...(event.artifacts ? { artifacts: event.artifacts } : {}),
            };
      const index = previous.findIndex(
        (item) => item.type === "tool" && item.toolCallId === event.toolCallId,
      );
      if (index < 0) return [...previous, block];
      return previous.map((item, itemIndex) =>
        itemIndex === index ? { ...item, ...block } : item,
      );
    }
    case "run.failed": {
      const blocks = finishRunningTools(previous, "处理失败");
      if (blocks.some((block) => block.type === "text")) return blocks;
      return [
        ...blocks,
        {
          type: "text",
          text: "抱歉，处理过程中遇到问题，请重试。",
        },
      ];
    }
    case "run.canceled":
      return finishRunningTools(previous);
    default:
      return previous;
  }
}

function finishRunningTools(
  blocks: ContentBlock[],
  outputSummary?: string,
): ContentBlock[] {
  let changed = false;
  const next = blocks.map((block) => {
    if (block.type !== "tool" || block.status !== "running") return block;
    changed = true;
    return {
      ...block,
      status: "completed" as const,
      ...(outputSummary ? { outputSummary } : {}),
    };
  });
  return changed ? next : blocks;
}
