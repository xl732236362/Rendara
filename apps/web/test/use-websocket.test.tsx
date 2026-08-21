// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useWebSocket } from "../src/hooks/use-websocket";

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: (() => void) | null = null;
  send = vi.fn();

  constructor(_url: string) {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }

  close() {
    this.readyState = 3;
  }

  serverClose(code: number) {
    this.readyState = 3;
    this.onclose?.({ code } as CloseEvent);
  }

  receive(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent);
  }
}

describe("useWebSocket Agent correlation", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("settles only the matching request when a pre-ACK error arrives", async () => {
    const { result, unmount } = renderHook(() => useWebSocket(() => "token"));
    await waitFor(() => expect(result.current.connected).toBe(true));
    const onAck = vi.fn();
    const onError = vi.fn();

    act(() => {
      result.current.startRun(
        {
          canvasId: "canvas-1",
          clientRequestId: "request-1",
          conversationId: "conversation-1",
          prompt: "hello",
          sessionId: "session-1",
        },
        { onAck, onError },
      );
      FakeWebSocket.instances[0]?.receive({
        type: "error",
        action: "agent.run",
        clientRequestId: "request-1",
        retryable: true,
        error: {
          code: "agent_acceptance_indeterminate",
          message: "Agent acceptance is still being confirmed.",
        },
      });
    });

    expect(onError).toHaveBeenCalledOnce();
    expect(onAck).not.toHaveBeenCalled();
    unmount();
  });

  it("emits a neutral replayable event for assistant persistence exhaustion", async () => {
    const { result, unmount } = renderHook(() => useWebSocket(() => "token"));
    await waitFor(() => expect(result.current.connected).toBe(true));
    const onEvent = vi.fn();
    const unsubscribe = result.current.onEvent(onEvent);

    act(() => {
      FakeWebSocket.instances[0]?.receive({
        type: "error",
        action: "agent.run",
        runId: "run-1",
        error: {
          code: "assistant_message_persistence_failed",
          message: "The assistant response could not be saved.",
        },
      });
    });

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "assistant.persistence_failed",
        runId: "run-1",
      }),
    );
    expect(onEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "run.failed" }),
    );
    unsubscribe();
    unmount();
  });

  it("resumes from the latest buffered sequence and ignores duplicate replay events", async () => {
    const { result, unmount } = renderHook(() => useWebSocket(() => "token"));
    await waitFor(() => expect(result.current.connected).toBe(true));
    const onEvent = vi.fn();
    const unsubscribe = result.current.onEvent(onEvent);

    act(() => {
      result.current.resumeCanvas("canvas-1");
      FakeWebSocket.instances[0]?.receive({
        type: "event",
        seq: 4,
        event: {
          type: "message.delta",
          runId: "run-1",
          messageId: "message-1",
          delta: "once",
          timestamp: "2026-08-20T00:00:00.000Z",
        },
      });
      FakeWebSocket.instances[0]?.receive({
        type: "event",
        seq: 4,
        event: {
          type: "message.delta",
          runId: "run-1",
          messageId: "message-1",
          delta: "duplicate",
          timestamp: "2026-08-20T00:00:01.000Z",
        },
      });
      result.current.resumeCanvas("canvas-1");
    });

    const resumeCommands = FakeWebSocket.instances
      .at(-1)
      ?.send.mock.calls.map(([payload]) => JSON.parse(payload as string))
      .filter((message) => message.action === "canvas.resume");
    expect(resumeCommands).toEqual([
      expect.objectContaining({
        payload: { canvasId: "canvas-1", lastSeq: 0 },
      }),
      expect.objectContaining({
        payload: { canvasId: "canvas-1", lastSeq: 4 },
      }),
    ]);
    expect(onEvent).toHaveBeenCalledTimes(1);
    unsubscribe();
    unmount();
  });

  it("tracks live run sequences before the first explicit resume", async () => {
    const { result, unmount } = renderHook(() => useWebSocket(() => "token"));
    await waitFor(() => expect(result.current.connected).toBe(true));
    const onAck = vi.fn();
    const onError = vi.fn();
    const onEvent = vi.fn();
    const unsubscribe = result.current.onEvent(onEvent);

    act(() => {
      result.current.startRun(
        {
          canvasId: "canvas-1",
          clientRequestId: "request-live",
          conversationId: "conversation-1",
          prompt: "hello",
          sessionId: "session-1",
        },
        { onAck, onError },
      );
      FakeWebSocket.instances[0]?.receive({
        type: "event",
        seq: 2,
        event: {
          type: "message.delta",
          runId: "run-1",
          messageId: "message-1",
          delta: "live",
          timestamp: "2026-08-20T00:00:00.000Z",
        },
      });
      result.current.resumeCanvas("canvas-1");
    });

    const resume = FakeWebSocket.instances
      .at(-1)
      ?.send.mock.calls.map(([payload]) => JSON.parse(payload as string))
      .find((message) => message.action === "canvas.resume");
    expect(resume.payload.lastSeq).toBe(2);
    unsubscribe();
    unmount();
  });

  it("resets a stale sequence cursor when the server restarts", async () => {
    const { result, unmount } = renderHook(() => useWebSocket(() => "token"));
    await waitFor(() => expect(result.current.connected).toBe(true));

    act(() => {
      result.current.resumeCanvas("canvas-1", vi.fn());
      FakeWebSocket.instances[0]?.receive({
        type: "event",
        seq: 4,
        event: {
          type: "message.delta",
          runId: "run-1",
          messageId: "message-1",
          delta: "before restart",
          timestamp: "2026-08-20T00:00:00.000Z",
        },
      });
      FakeWebSocket.instances[0]?.receive({
        type: "command.ack",
        action: "canvas.resume",
        payload: { canvasId: "canvas-1", latestSeq: 0 },
      });
      result.current.resumeCanvas("canvas-1");
    });

    const resumes = FakeWebSocket.instances
      .at(-1)
      ?.send.mock.calls.map(([payload]) => JSON.parse(payload as string))
      .filter((message) => message.action === "canvas.resume");
    expect(resumes?.at(-1)?.payload.lastSeq).toBe(0);
    unmount();
  });

  it("advances to the server cursor after an explicit replay gap", async () => {
    const { result, unmount } = renderHook(() => useWebSocket(() => "token"));
    await waitFor(() => expect(result.current.connected).toBe(true));

    act(() => {
      result.current.resumeCanvas("canvas-1", vi.fn());
      FakeWebSocket.instances[0]?.receive({
        type: "command.ack",
        action: "canvas.resume",
        payload: { canvasId: "canvas-1", latestSeq: 9, replayGap: true },
      });
      result.current.resumeCanvas("canvas-1");
    });

    const resumes = FakeWebSocket.instances
      .at(-1)
      ?.send.mock.calls.map(([payload]) => JSON.parse(payload as string))
      .filter((message) => message.action === "canvas.resume");
    expect(resumes?.at(-1)?.payload.lastSeq).toBe(9);
    unmount();
  });

  it("keeps an active stream recoverable when finalization is unconfirmed", async () => {
    const { result, unmount } = renderHook(() => useWebSocket(() => "token"));
    await waitFor(() => expect(result.current.connected).toBe(true));
    const onAck = vi.fn();
    const onError = vi.fn();
    const onEvent = vi.fn();
    const unsubscribe = result.current.onEvent(onEvent);

    act(() => {
      result.current.startRun(
        {
          canvasId: "canvas-1",
          clientRequestId: "request-1",
          conversationId: "conversation-1",
          prompt: "hello",
          sessionId: "session-1",
        },
        { onAck, onError },
      );
      FakeWebSocket.instances[0]?.receive({
        type: "error",
        action: "agent.run",
        clientRequestId: "request-1",
        runId: "run-1",
        error: {
          code: "run_finalization_unconfirmed",
          message: "The server cannot confirm the final run state.",
        },
      });
    });

    expect(onEvent).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    act(() => {
      FakeWebSocket.instances[0]?.receive({
        type: "command.ack",
        action: "agent.run",
        payload: { clientRequestId: "request-1", runId: "run-1" },
      });
    });
    expect(onAck).toHaveBeenCalledOnce();
    unsubscribe();
    unmount();
  });

  it("treats authentication rejection as terminal and does not reconnect", async () => {
    vi.useFakeTimers();
    const onAuthExpired = vi.fn();
    const getToken = vi.fn(() => "expired-token");
    const { result, unmount } = renderHook(() =>
      useWebSocket(getToken, { onAuthExpired }),
    );
    await act(async () => {
      await vi.runAllTicks();
    });
    expect(result.current.connected).toBe(true);
    const instanceCountBeforeAuthFailure = FakeWebSocket.instances.length;

    act(() => {
      FakeWebSocket.instances.at(-1)?.serverClose(4001);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(onAuthExpired).toHaveBeenCalledOnce();
    expect(FakeWebSocket.instances).toHaveLength(
      instanceCountBeforeAuthFailure,
    );
    unmount();
    vi.useRealTimers();
  });
});
