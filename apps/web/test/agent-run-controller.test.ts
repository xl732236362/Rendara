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
});
