import { describe, expect, it } from "vitest";

import { createToolExecutionSupervisor } from "./tool-execution-supervisor.js";

const startInput = {
  input: { mode: "summary" },
  inputDigest: "digest-1",
  logicalToolCallId: "call-1",
  toolName: "inspect_canvas",
} as const;

function supervisor(overrides: { maxBytes?: number; maxCalls?: number } = {}) {
  return createToolExecutionSupervisor({
    agentRunId: "run-1",
    attemptId: "attempt-1",
    maxBytes: overrides.maxBytes ?? 64_000,
    maxCalls: overrides.maxCalls ?? 4,
    now: () => "2026-08-19T12:00:00.000Z",
  });
}

describe("tool execution supervisor", () => {
  it("admits one start and one terminal record in order", () => {
    const subject = supervisor();

    const started = subject.stageStart(startInput);
    expect(subject.callState("call-1")).toBe("starting");
    expect(subject.acknowledge(started)).toBe("projected");
    expect(subject.callState("call-1")).toBe("open");

    const completed = subject.stageCompleted("call-1", {
      outputSummary: "Canvas inspected.",
    });
    expect(subject.callState("call-1")).toBe("finishing");
    expect(subject.acknowledge(completed)).toBe("projected");
    expect(subject.callState("call-1")).toBe("terminal");
    expect(subject.records()).toEqual([started, completed]);
  });

  it("rejects a reused logical tool call ID before another start", () => {
    const subject = supervisor();
    subject.stageStart(startInput);

    expect(() => subject.stageStart(startInput)).toThrow(
      "duplicate_logical_tool_call_id",
    );
    expect(subject.records()).toHaveLength(1);
  });

  it("accepts an exact projected transport replay but rejects changed payload", () => {
    const subject = supervisor();
    const started = subject.stageStart(startInput);

    expect(subject.acknowledge(started)).toBe("projected");
    expect(subject.acknowledge(started)).toBe("duplicate");
    expect(() =>
      subject.acknowledge({
        ...started,
        toolName: "manipulate_canvas",
      }),
    ).toThrow("tool_lifecycle_record_conflict");
  });

  it("closes open calls once and rejects late completion", () => {
    const subject = supervisor();
    const started = subject.stageStart(startInput);
    subject.acknowledge(started);

    const abandoned = subject.closeOpenCalls({
      code: "run_closed",
      correlationId: "correlation-1",
      message: "The run ended before this tool completed.",
    });

    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]).toMatchObject({
      type: "loomic.tool.failed",
      logicalToolCallId: "call-1",
    });
    expect(
      subject.closeOpenCalls({
        code: "run_closed",
        correlationId: "correlation-1",
        message: "The run ended before this tool completed.",
      }),
    ).toEqual([]);
    expect(() => subject.stageCompleted("call-1", {})).toThrow(
      "tool_supervisor_closing",
    );

    const abandonedRecord = abandoned[0];
    if (!abandonedRecord) throw new Error("Expected an abandoned tool record.");
    subject.acknowledge(abandonedRecord);
    expect(subject.callState("call-1")).toBe("terminal");
  });

  it("rejects capacity exhaustion before recording another call", () => {
    const subject = supervisor({ maxCalls: 1 });
    subject.stageStart(startInput);

    expect(() =>
      subject.stageStart({
        ...startInput,
        logicalToolCallId: "call-2",
      }),
    ).toThrow("tool_supervisor_capacity_exhausted");
    expect(subject.callState("call-2")).toBeUndefined();
  });
});
