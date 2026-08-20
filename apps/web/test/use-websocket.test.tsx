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

  it("keeps an active stream recoverable when finalization is unconfirmed", async () => {
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
          code: "run_finalization_unconfirmed",
          message: "The server cannot confirm the final run state.",
        },
      });
    });

    expect(onEvent).not.toHaveBeenCalled();
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
