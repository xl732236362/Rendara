import { describe, expect, it } from "vitest";

import { adaptDeepAgentStream } from "./stream-adapter.js";
import { createToolExecutionSupervisor } from "./tool-execution-supervisor.js";
import type { CanonicalToolRecord } from "./tool-lifecycle.js";

describe("Agent stream adapter", () => {
  it("ignores nested tracing lifecycles and projects canonical records once", async () => {
    const supervisor = createToolExecutionSupervisor({
      agentRunId: "run-1",
      attemptId: "attempt-1",
      maxBytes: 64_000,
      maxCalls: 4,
      now: () => "2026-08-19T12:00:00.000Z",
    });
    const started = supervisor.stageStart({
      input: { mode: "summary" },
      inputDigest: "digest-1",
      logicalToolCallId: "model-call-1",
      toolName: "inspect_canvas",
    });

    async function* frameworkEvents() {
      yield tracing("on_tool_start", "outer-framework-run");
      yield tracing("on_tool_start", "inner-framework-run");
      yield custom(started);
      expect(supervisor.callState("model-call-1")).toBe("open");
      const completed = supervisor.stageCompleted("model-call-1", {
        outputSummary: "Canvas inspected.",
      });
      yield tracing("on_tool_end", "inner-framework-run");
      yield tracing("on_tool_end", "outer-framework-run");
      yield custom(completed);
      yield custom(completed);
    }

    const publicEvents = [];
    for await (const event of adaptDeepAgentStream({
      conversationId: "conversation-1",
      now: () => "2026-08-19T12:00:00.000Z",
      runId: "run-1",
      sessionId: "session-1",
      stream: frameworkEvents(),
      supervisor,
    })) {
      publicEvents.push(event);
    }

    expect(
      publicEvents.filter((event) => event.type.startsWith("tool.")),
    ).toEqual([
      expect.objectContaining({
        type: "tool.started",
        toolCallId: "model-call-1",
      }),
      expect.objectContaining({
        type: "tool.completed",
        toolCallId: "model-call-1",
      }),
    ]);
    expect(supervisor.callState("model-call-1")).toBe("terminal");
    expect(publicEvents.some((event) => event.type === "canvas.sync")).toBe(
      false,
    );
  });

  it("rejects a changed copy of a staged canonical record", async () => {
    const supervisor = createToolExecutionSupervisor({
      agentRunId: "run-1",
      attemptId: "attempt-1",
      maxBytes: 64_000,
      maxCalls: 4,
    });
    const started = supervisor.stageStart({
      inputDigest: "digest-1",
      logicalToolCallId: "model-call-1",
      toolName: "inspect_canvas",
    });

    await expect(async () => {
      for await (const _event of adaptDeepAgentStream({
        conversationId: "conversation-1",
        runId: "run-1",
        sessionId: "session-1",
        stream: from([custom({ ...started, toolName: "manipulate_canvas" })]),
        supervisor,
      })) {
        // Consume the adapter to surface the protocol failure.
      }
    }).rejects.toThrow("tool_lifecycle_record_conflict");
  });
});

function tracing(event: "on_tool_start" | "on_tool_end", runId: string) {
  return {
    event,
    name: "inspect_canvas",
    run_id: runId,
    data: event === "on_tool_start" ? { input: { mode: "summary" } } : {},
  };
}

function custom(record: CanonicalToolRecord) {
  return {
    event: "on_custom_event",
    name: record.type,
    data: record,
  };
}

async function* from(events: readonly unknown[]) {
  yield* events;
}
