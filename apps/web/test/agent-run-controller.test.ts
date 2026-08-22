import type { StreamEvent } from "@loomic/shared";
import { describe, expect, it, vi } from "vitest";

import { createAgentRunController } from "../src/lib/agent-run-controller";

function createSocket() {
  let listener: ((event: StreamEvent) => void) | undefined;
  let resumeAck: ((ack: unknown) => void) | undefined;
  const unsubscribe = vi.fn();
  return {
    ws: {
      onEvent: vi.fn((next: (event: StreamEvent) => void) => {
        listener = next;
        return unsubscribe;
      }),
      resumeCanvas: vi.fn(
        (_canvasId: string, onAck?: (ack: unknown) => void) => {
          resumeAck = onAck;
        },
      ),
    },
    emit(event: StreamEvent) {
      listener?.(event);
    },
    acknowledgeResume(payload: Record<string, unknown>) {
      resumeAck?.({ payload });
    },
    unsubscribe,
  };
}

describe("createAgentRunController", () => {
  it("owns one canvas subscription and preserves state across UI subscribers", () => {
    const socket = createSocket();
    const controller = createAgentRunController({
      canvasId: "canvas-1",
      ws: socket.ws,
    });
    const first = vi.fn();
    const stopFirst = controller.subscribe(first);
    controller.startRun({
      runId: "run-1",
      sessionId: "session-1",
      assistantId: "assistant-1",
    });
    stopFirst();
    socket.emit({
      type: "message.delta",
      runId: "run-1",
      delta: "still running",
    } as StreamEvent);
    const second = vi.fn();
    controller.subscribe(second);

    expect(socket.ws.onEvent).toHaveBeenCalledOnce();
    expect(controller.getRuns().get("run-1")?.contentBlocks).toEqual([
      { type: "text", text: "still running" },
    ]);
    expect(second).toHaveBeenCalledOnce();
  });

  it("routes registered runs and ignores events for unknown runs", () => {
    const socket = createSocket();
    const controller = createAgentRunController({
      canvasId: "canvas-1",
      ws: socket.ws,
    });
    controller.startRun({
      runId: "run-1",
      sessionId: "session-1",
      assistantId: "assistant-1",
    });
    socket.emit({
      type: "message.delta",
      runId: "run-other",
      delta: "wrong",
    } as StreamEvent);
    socket.emit({
      type: "message.delta",
      runId: "run-1",
      delta: "right",
    } as StreamEvent);

    expect(controller.getRuns().get("run-1")?.contentBlocks).toEqual([
      { type: "text", text: "right" },
    ]);
  });

  it("rejects run events from a different session or canvas", () => {
    const socket = createSocket();
    const onRunEvent = vi.fn();
    const onDiagnostic = vi.fn();
    const controller = createAgentRunController({
      canvasId: "canvas-1",
      ws: socket.ws,
      onRunEvent,
      onDiagnostic,
    });
    controller.startRun({
      runId: "run-1",
      sessionId: "session-1",
      assistantId: "assistant-1",
    });

    socket.emit({
      type: "run.started",
      runId: "run-1",
      sessionId: "session-other",
      conversationId: "canvas-1",
      timestamp: "2026-08-22T00:00:00.000Z",
    });
    socket.emit({
      type: "run.started",
      runId: "run-1",
      sessionId: "session-1",
      conversationId: "canvas-other",
      timestamp: "2026-08-22T00:00:00.000Z",
    });

    expect(onRunEvent).not.toHaveBeenCalled();
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ marker: "run_event_session_mismatch" }),
    );
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ marker: "run_event_canvas_mismatch" }),
    );
  });

  it("retains terminal snapshots until acknowledged", () => {
    const socket = createSocket();
    const controller = createAgentRunController({
      canvasId: "canvas-1",
      ws: socket.ws,
    });
    controller.startRun({
      runId: "run-1",
      sessionId: "session-1",
      assistantId: "assistant-1",
    });
    socket.emit({ type: "run.completed", runId: "run-1" } as StreamEvent);

    expect(controller.getRuns().get("run-1")?.status).toBe("completed");
    controller.acknowledgeTerminal("run-1");
    expect(controller.getRuns().has("run-1")).toBe(false);
  });

  it("marks a running run as stopping until a terminal event arrives", () => {
    const socket = createSocket();
    const controller = createAgentRunController({
      canvasId: "canvas-1",
      ws: socket.ws,
    });
    controller.startRun({
      runId: "run-1",
      sessionId: "session-1",
      assistantId: "assistant-1",
    });

    controller.markStopping("run-1");
    expect(controller.getRuns().get("run-1")?.status).toBe("stopping");

    socket.emit({ type: "run.canceled", runId: "run-1" } as StreamEvent);
    expect(controller.getRuns().get("run-1")?.status).toBe("canceled");
  });

  it("owns terminal waiting without treating stopping as terminal", async () => {
    const socket = createSocket();
    const controller = createAgentRunController({
      canvasId: "canvas-1",
      ws: socket.ws,
    });
    controller.startRun({
      runId: "run-1",
      sessionId: "session-1",
      assistantId: "assistant-1",
    });
    const settled = vi.fn();
    const terminal = controller.waitForTerminal("run-1");
    void terminal.then(settled);

    controller.markStopping("run-1");
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    socket.emit({ type: "run.canceled", runId: "run-1" } as StreamEvent);
    await expect(terminal).resolves.toMatchObject({
      runId: "run-1",
      status: "canceled",
    });
  });

  it("runs persistence fallback once without a UI subscriber", () => {
    const socket = createSocket();
    const onPersistenceFailure = vi.fn();
    const controller = createAgentRunController({
      canvasId: "canvas-1",
      ws: socket.ws,
      onPersistenceFailure,
    });
    controller.startRun({
      runId: "run-1",
      sessionId: "session-1",
      assistantId: "assistant-1",
    });
    const event = {
      type: "assistant.persistence_failed",
      runId: "run-1",
      sessionId: "session-1",
    } as StreamEvent;
    socket.emit(event);
    socket.emit(event);

    expect(onPersistenceFailure).toHaveBeenCalledOnce();
  });

  it("disposes its socket subscription idempotently", () => {
    const socket = createSocket();
    const controller = createAgentRunController({
      canvasId: "canvas-1",
      ws: socket.ws,
    });
    controller.dispose();
    controller.dispose();

    expect(socket.unsubscribe).toHaveBeenCalledOnce();
  });

  it("ignores later events and resolves waiters after run disposal", async () => {
    const socket = createSocket();
    const onRunEvent = vi.fn();
    const onDiagnostic = vi.fn();
    const controller = createAgentRunController({
      canvasId: "canvas-1",
      ws: socket.ws,
      onRunEvent,
      onDiagnostic,
    });
    controller.startRun({
      runId: "run-1",
      sessionId: "session-1",
      assistantId: "assistant-1",
    });
    const terminal = controller.waitForTerminal("run-1");

    controller.disposeRun("run-1");
    controller.disposeRun("run-1");
    socket.emit({
      type: "message.delta",
      runId: "run-1",
      delta: "late",
    } as StreamEvent);

    await expect(terminal).resolves.toBeUndefined();
    expect(onRunEvent).not.toHaveBeenCalled();
    expect(controller.getRuns()).toHaveLength(0);
    expect(onDiagnostic).toHaveBeenCalledWith({
      marker: "run_disposed",
      canvasId: "canvas-1",
      runId: "run-1",
      sessionId: "session-1",
    });
    expect(
      onDiagnostic.mock.calls.filter(
        ([diagnostic]) => diagnostic.marker === "run_disposed",
      ),
    ).toHaveLength(1);
  });

  it("requests canvas resume and reports a replay gap", () => {
    const socket = createSocket();
    const onReplayGap = vi.fn();
    const controller = createAgentRunController({
      canvasId: "canvas-1",
      ws: socket.ws,
      onReplayGap,
    });
    controller.requestResume();
    socket.acknowledgeResume({
      replayGap: true,
      activeRunSessionId: "session-1",
    });

    expect(socket.ws.resumeCanvas).toHaveBeenCalledWith(
      "canvas-1",
      expect.any(Function),
    );
    expect(onReplayGap).toHaveBeenCalledWith({
      canvasId: "canvas-1",
      sessionId: "session-1",
    });
  });

  it("reports a replay gap when the server has no active session", () => {
    const socket = createSocket();
    const onReplayGap = vi.fn();
    const controller = createAgentRunController({
      canvasId: "canvas-1",
      ws: socket.ws,
      onReplayGap,
    });
    controller.requestResume();
    socket.acknowledgeResume({
      replayGap: true,
      activeRunSessionId: null,
    });

    expect(onReplayGap).toHaveBeenCalledWith({ canvasId: "canvas-1" });
  });

  it("isolates a resume acknowledgement for the same run in another session", () => {
    const socket = createSocket();
    const onDiagnostic = vi.fn();
    const onReplayGap = vi.fn();
    const controller = createAgentRunController({
      canvasId: "canvas-1",
      ws: socket.ws,
      onDiagnostic,
      onReplayGap,
    });
    controller.startRun({
      runId: "run-1",
      sessionId: "session-local",
      assistantId: "assistant-local",
    });

    controller.requestResume();
    socket.acknowledgeResume({
      activeRunId: "run-1",
      activeRunSessionId: "session-server",
      replayGap: false,
    });

    socket.emit({
      type: "message.delta",
      runId: "run-1",
      delta: "server replay",
    } as StreamEvent);

    expect(controller.getRuns().get("run-1")).toMatchObject({
      sessionId: "session-server",
      assistantId: "resumed_run-1",
      contentBlocks: [{ type: "text", text: "server replay" }],
    });
    expect(onDiagnostic).toHaveBeenCalledWith({
      marker: "resume_session_mismatch",
      canvasId: "canvas-1",
      runId: "run-1",
      sessionId: "session-server",
    });
    expect(onReplayGap).toHaveBeenCalledWith({
      canvasId: "canvas-1",
      sessionId: "session-server",
    });
  });

  it("prunes expired terminal snapshots without removing active runs", () => {
    const socket = createSocket();
    let time = 0;
    const controller = createAgentRunController({
      canvasId: "canvas-1",
      ws: socket.ws,
      now: () => time,
    });
    controller.startRun({ runId: "old", sessionId: "s1", assistantId: "a1" });
    socket.emit({ type: "run.completed", runId: "old" } as StreamEvent);
    time = 31 * 60 * 1000;
    controller.startRun({
      runId: "active",
      sessionId: "s2",
      assistantId: "a2",
    });

    expect(controller.getRuns().has("old")).toBe(false);
    expect(controller.getRuns().get("active")?.status).toBe("running");
  });

  it("retains at most twenty terminal snapshots", () => {
    const socket = createSocket();
    let time = 0;
    const controller = createAgentRunController({
      canvasId: "canvas-1",
      ws: socket.ws,
      now: () => time,
    });
    for (let index = 0; index < 21; index++) {
      time = index;
      controller.startRun({
        runId: `run-${index}`,
        sessionId: `session-${index}`,
        assistantId: `assistant-${index}`,
      });
      socket.emit({
        type: "run.completed",
        runId: `run-${index}`,
      } as StreamEvent);
    }

    expect(controller.getRuns()).toHaveLength(20);
    expect(controller.getRuns().has("run-0")).toBe(false);
    expect(controller.getRuns().has("run-20")).toBe(true);
  });

  it("records idempotent disposal without exposing payload data", () => {
    const socket = createSocket();
    const onDiagnostic = vi.fn();
    const controller = createAgentRunController({
      canvasId: "canvas-1",
      ws: socket.ws,
      onDiagnostic,
    });

    controller.dispose();
    controller.dispose();

    expect(onDiagnostic).toHaveBeenCalledOnce();
    expect(onDiagnostic).toHaveBeenCalledWith({
      marker: "controller_disposed",
      canvasId: "canvas-1",
      runCount: 0,
    });
  });
});
