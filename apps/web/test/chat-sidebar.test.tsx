// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import type { StreamEvent } from "@loomic/shared";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatSidebar } from "../src/components/chat-sidebar";
import { TierLimitToastProvider } from "../src/components/credits/tier-limit-toast";
import { ToastProvider } from "../src/components/toast";
import {
  mapServerMessages,
  mergeReloadedMessages,
} from "../src/hooks/use-chat-sessions";
import type { WebSocketHandle } from "../src/hooks/use-websocket";

const {
  createSessionMock,
  deleteSessionMock,
  fetchMessagesMock,
  fetchImageModelsMock,
  fetchModelsMock,
  fetchGeneratedAssetAttachmentMock,
  fetchOutstandingGeneratedAssetAttachmentsMock,
  fetchSessionsMock,
  retryGeneratedAssetAttachmentMock,
  saveMessageMock,
  updateSessionTitleMock,
} = vi.hoisted(() => ({
  createSessionMock: vi.fn(),
  deleteSessionMock: vi.fn(),
  fetchMessagesMock: vi.fn(),
  fetchImageModelsMock: vi.fn(),
  fetchModelsMock: vi.fn(),
  fetchGeneratedAssetAttachmentMock: vi.fn(),
  fetchOutstandingGeneratedAssetAttachmentsMock: vi.fn(),
  fetchSessionsMock: vi.fn(),
  retryGeneratedAssetAttachmentMock: vi.fn(),
  saveMessageMock: vi.fn(),
  updateSessionTitleMock: vi.fn(),
}));

vi.mock("../src/lib/server-api", () => ({
  createSession: createSessionMock,
  deleteSession: deleteSessionMock,
  fetchMessages: fetchMessagesMock,
  fetchImageModels: fetchImageModelsMock,
  fetchModels: fetchModelsMock,
  fetchGeneratedAssetAttachment: fetchGeneratedAssetAttachmentMock,
  fetchOutstandingGeneratedAssetAttachments:
    fetchOutstandingGeneratedAssetAttachmentsMock,
  fetchSessions: fetchSessionsMock,
  retryGeneratedAssetAttachment: retryGeneratedAssetAttachmentMock,
  saveMessage: saveMessageMock,
  updateSessionTitle: updateSessionTitleMock,
}));

function createMockWs(): WebSocketHandle {
  return {
    connected: true,
    startRun: vi.fn((payload, callbacks) => {
      // Simulate server ack
      callbacks?.onAck({
        type: "command.ack",
        action: "agent.run",
        payload: { runId: "run_123", clientRequestId: payload.clientRequestId },
      });
      return true;
    }),
    cancelRun: vi.fn(),
    onEvent: vi.fn(() => () => {}),
    registerRPC: vi.fn(() => () => {}),
    resumeCanvas: vi.fn(),
  };
}

describe("ChatSidebar", () => {
  it("drops a local assistant placeholder when the server has persisted its response", () => {
    const merged = mergeReloadedMessages(
      [
        {
          id: "server-assistant",
          role: "assistant",
          contentBlocks: [{ type: "text", text: "completed response" }],
        },
      ],
      [
        {
          id: "assistant-local",
          role: "assistant",
          contentBlocks: [{ type: "text", text: "completed response" }],
        },
      ],
      new Set(["assistant-local"]),
    );

    expect(merged.map((message) => message.id)).toEqual(["server-assistant"]);
  });

  it("replaces a partial local assistant with a richer persisted response", () => {
    const merged = mergeReloadedMessages(
      [
        {
          id: "server-assistant",
          role: "assistant",
          contentBlocks: [
            { type: "text", text: "completed response with tail" },
          ],
        },
      ],
      [
        {
          id: "assistant-local",
          role: "assistant",
          contentBlocks: [{ type: "text", text: "completed response" }],
        },
      ],
      new Set(["assistant-local"]),
    );

    expect(merged.map((message) => message.id)).toEqual(["server-assistant"]);
  });

  let mockWs: WebSocketHandle;

  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes("1024px"),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
      writable: true,
    });
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
      writable: true,
    });
    mockWs = createMockWs();
    createSessionMock.mockReset();
    createSessionMock.mockResolvedValue({
      session: {
        id: "session-created",
        title: "New Chat",
        updatedAt: "2026-03-24T00:00:00.000Z",
      },
    });
    deleteSessionMock.mockReset();
    fetchMessagesMock.mockReset();
    fetchMessagesMock.mockResolvedValue({ messages: [] });
    fetchImageModelsMock.mockReset();
    fetchImageModelsMock.mockResolvedValue({ models: [] });
    fetchModelsMock.mockReset();
    fetchModelsMock.mockResolvedValue({ models: [] });
    fetchGeneratedAssetAttachmentMock.mockReset();
    fetchGeneratedAssetAttachmentMock.mockImplementation(
      async (_token, _canvasId, jobId) => ({
        attachment: { attachmentStatus: "not_requested", jobId },
      }),
    );
    fetchOutstandingGeneratedAssetAttachmentsMock.mockReset();
    fetchOutstandingGeneratedAssetAttachmentsMock.mockResolvedValue({
      attachments: [],
    });
    retryGeneratedAssetAttachmentMock.mockReset();
    fetchSessionsMock.mockReset();
    fetchSessionsMock.mockResolvedValue({
      sessions: [
        {
          id: "session-real",
          title: "Existing Chat",
          updatedAt: "2026-03-24T00:00:00.000Z",
        },
      ],
    });
    saveMessageMock.mockReset();
    saveMessageMock.mockResolvedValue(undefined);
    updateSessionTitleMock.mockReset();
    updateSessionTitleMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("starts runs via WebSocket with the active real session id", async () => {
    render(
      <ToastProvider>
        <TierLimitToastProvider>
          <ChatSidebar
            accessToken="token_abc"
            canvasId="canvas-1"
            open
            onToggle={() => {}}
            ws={mockWs}
          />
        </TierLimitToastProvider>
      </ToastProvider>,
    );

    const input = await screen.findByPlaceholderText(/start with an idea/i);
    await userEvent.type(input, "hello loom{Enter}");

    await waitFor(() =>
      expect(mockWs.startRun).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "session-real",
          conversationId: "canvas-1",
          prompt: "hello loom",
          canvasId: "canvas-1",
        }),
        expect.objectContaining({
          onAck: expect.any(Function),
          onError: expect.any(Function),
        }),
      ),
    );
    expect(mockWs.startRun).not.toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-canvas-1",
      }),
      expect.anything(),
    );
  });

  it("shows a stop control for an acknowledged run and cancels that run", async () => {
    render(
      <ToastProvider>
        <TierLimitToastProvider>
          <ChatSidebar
            accessToken="token_abc"
            canvasId="canvas-1"
            open
            onToggle={() => {}}
            ws={mockWs}
          />
        </TierLimitToastProvider>
      </ToastProvider>,
    );

    const input = await screen.findByPlaceholderText(/start with an idea/i);
    await userEvent.type(input, "hello loom{Enter}");

    const stopButton = await screen.findByRole("button", {
      name: "停止运行",
    });
    await userEvent.click(stopButton);

    expect(mockWs.cancelRun).toHaveBeenCalledWith("run_123");
  });

  it("retries acceptance with the same request without duplicating the user message", async () => {
    const startRun = vi.fn((payload, callbacks) => {
      if (startRun.mock.calls.length === 1) {
        callbacks?.onError({
          type: "error",
          action: "agent.run",
          clientRequestId: payload.clientRequestId,
          retryable: true,
          error: {
            code: "agent_acceptance_indeterminate",
            message: "Agent acceptance is still being confirmed.",
          },
        });
      } else {
        callbacks?.onAck({
          type: "command.ack",
          action: "agent.run",
          payload: {
            runId: "run_123",
            clientRequestId: payload.clientRequestId,
          },
        });
      }
      return true;
    });
    mockWs.startRun = startRun;
    render(
      <ToastProvider>
        <TierLimitToastProvider>
          <ChatSidebar
            accessToken="token_abc"
            canvasId="canvas-1"
            open
            onToggle={() => {}}
            ws={mockWs}
          />
        </TierLimitToastProvider>
      </ToastProvider>,
    );

    const input = await screen.findByPlaceholderText(/start with an idea/i);
    await userEvent.type(input, "retry me{Enter}");
    const retry = await screen.findByRole("button", { name: "重试" });
    const firstRequestId = startRun.mock.calls[0]?.[0].clientRequestId;
    await userEvent.click(retry);

    await waitFor(() => expect(startRun).toHaveBeenCalledTimes(2));
    expect(startRun.mock.calls[1]?.[0].clientRequestId).toBe(firstRequestId);
    expect(saveMessageMock).toHaveBeenCalledTimes(1);
    expect(
      [...document.querySelectorAll(".items-end")].filter((element) =>
        element.textContent?.includes("retry me"),
      ),
    ).toHaveLength(1);
  });

  it("preserves failed attachment recovery metadata when mapping saved messages", () => {
    const messages = mapServerMessages([
      {
        id: "message-1",
        role: "assistant",
        content: "",
        createdAt: "2026-08-20T00:00:00.000Z",
        toolActivities: [
          {
            toolCallId: "tool-1",
            toolName: "generate_image",
            status: "failed",
            error: {
              code: "generated_asset_not_attached",
              message: "Generated, but not attached",
              correlationId: "correlation-1",
            },
            recovery: {
              kind: "attach_generated_asset",
              jobId: "11111111-1111-4111-8111-111111111111",
              canvasId: "22222222-2222-4222-8222-222222222222",
            },
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
    ]);

    expect(messages[0]?.contentBlocks[0]).toMatchObject({
      type: "tool",
      status: "failed",
      error: { code: "generated_asset_not_attached" },
      recovery: {
        kind: "attach_generated_asset",
        jobId: "11111111-1111-4111-8111-111111111111",
      },
      artifacts: [{ type: "image" }],
    });
  });

  it("surfaces an outstanding attachment once and retries the same job", async () => {
    const canvasId = "22222222-2222-4222-8222-222222222222";
    const jobId = "11111111-1111-4111-8111-111111111111";
    fetchOutstandingGeneratedAssetAttachmentsMock.mockResolvedValue({
      attachments: [
        {
          attachmentStatus: "not_attached",
          jobId,
          recovery: { kind: "attach_generated_asset", jobId, canvasId },
          error: {
            code: "generated_asset_not_attached",
            message: "Generated, but not attached",
            retryable: true,
          },
        },
      ],
    });
    retryGeneratedAssetAttachmentMock.mockResolvedValue({
      attachment: {
        attachmentStatus: "attached",
        jobId,
        elementId: "generated-element",
        canvasRevision: 8,
      },
    });
    const onCanvasSync = vi.fn();

    render(
      <ToastProvider>
        <TierLimitToastProvider>
          <ChatSidebar
            accessToken="token_abc"
            canvasId={canvasId}
            open
            onToggle={() => {}}
            onCanvasSync={onCanvasSync}
            ws={mockWs}
          />
        </TierLimitToastProvider>
      </ToastProvider>,
    );

    expect(
      await screen.findByText("Generated, but not attached"),
    ).toBeInTheDocument();
    const retry = screen.getByRole("button", { name: "Retry attachment" });
    await userEvent.click(retry);

    await waitFor(() =>
      expect(retryGeneratedAssetAttachmentMock).toHaveBeenCalledWith(
        "token_abc",
        canvasId,
        jobId,
      ),
    );
    expect(onCanvasSync).toHaveBeenCalledWith(
      expect.objectContaining({ canvasId, revision: 8, type: "canvas.sync" }),
    );
    expect(
      screen.queryByRole("button", { name: "Retry attachment" }),
    ).toBeNull();
  });

  it("renders a generated image when completion arrives without a started event", async () => {
    let listener: ((event: StreamEvent) => void) | undefined;
    mockWs.onEvent = vi.fn((callback) => {
      listener = callback;
      return () => {};
    });
    const onImageGenerated = vi.fn();
    const onVideoGenerated = vi.fn();
    render(
      <ToastProvider>
        <TierLimitToastProvider>
          <ChatSidebar
            accessToken="token_abc"
            canvasId="canvas-1"
            open
            onToggle={() => {}}
            onImageGenerated={onImageGenerated}
            onVideoGenerated={onVideoGenerated}
            ws={mockWs}
          />
        </TierLimitToastProvider>
      </ToastProvider>,
    );

    const input = await screen.findByPlaceholderText(/start with an idea/i);
    await userEvent.type(input, "generate media{Enter}");
    await waitFor(() => expect(listener).toBeDefined());
    listener?.({
      type: "tool.completed",
      runId: "run_123",
      toolCallId: "tool-1",
      toolName: "generate_image",
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
      timestamp: "2026-08-20T00:00:00.000Z",
    });

    expect(
      await screen.findByRole("img", { name: "Generated image" }),
    ).toHaveAttribute("src", "https://example.com/generated.png");
    expect(onImageGenerated).not.toHaveBeenCalled();
    expect(onVideoGenerated).not.toHaveBeenCalled();
  });

  it("refreshes a saved failed block and syncs an attachment completed while offline", async () => {
    const canvasId = "22222222-2222-4222-8222-222222222222";
    const jobId = "11111111-1111-4111-8111-111111111111";
    fetchMessagesMock.mockResolvedValue({
      messages: [
        {
          id: "message-1",
          role: "assistant",
          content: "",
          createdAt: "2026-08-20T00:00:00.000Z",
          contentBlocks: [
            {
              type: "tool",
              toolCallId: "tool-1",
              toolName: "generate_image",
              status: "failed",
              error: {
                code: "generated_asset_not_attached",
                message: "Generated, but not attached",
                correlationId: "correlation-1",
              },
              recovery: {
                kind: "attach_generated_asset",
                jobId,
                canvasId,
              },
            },
          ],
        },
      ],
    });
    fetchGeneratedAssetAttachmentMock.mockResolvedValue({
      attachment: {
        attachmentStatus: "attached",
        jobId,
        elementId: "generated-element",
        canvasRevision: 9,
      },
    });
    const onCanvasSync = vi.fn();

    render(
      <ToastProvider>
        <TierLimitToastProvider>
          <ChatSidebar
            accessToken="token_abc"
            canvasId={canvasId}
            open
            onToggle={() => {}}
            onCanvasSync={onCanvasSync}
            ws={mockWs}
          />
        </TierLimitToastProvider>
      </ToastProvider>,
    );

    await waitFor(() =>
      expect(fetchGeneratedAssetAttachmentMock).toHaveBeenCalledWith(
        "token_abc",
        canvasId,
        jobId,
      ),
    );
    await waitFor(() =>
      expect(onCanvasSync).toHaveBeenCalledWith(
        expect.objectContaining({ canvasId, revision: 9, type: "canvas.sync" }),
      ),
    );
    expect(
      screen.queryByRole("button", { name: "Retry attachment" }),
    ).toBeNull();
  });

  it("leaves terminal assistant persistence to the Agent server", async () => {
    const canvasId = "22222222-2222-4222-8222-222222222222";
    const jobId = "11111111-1111-4111-8111-111111111111";
    let listener: ((event: StreamEvent) => void) | undefined;
    mockWs.onEvent = vi.fn((callback) => {
      listener = callback;
      return () => {};
    });
    render(
      <ToastProvider>
        <TierLimitToastProvider>
          <ChatSidebar
            accessToken="token_abc"
            canvasId={canvasId}
            open
            onToggle={() => {}}
            ws={mockWs}
          />
        </TierLimitToastProvider>
      </ToastProvider>,
    );

    const input = await screen.findByPlaceholderText(/start with an idea/i);
    await userEvent.type(input, "generate and attach{Enter}");
    await waitFor(() => expect(listener).toBeDefined());
    listener?.({
      type: "tool.started",
      runId: "run_123",
      toolCallId: "tool-1",
      toolName: "generate_image",
      timestamp: "2026-08-20T00:00:00.000Z",
    });
    listener?.({
      type: "tool.failed",
      runId: "run_123",
      toolCallId: "tool-1",
      toolName: "generate_image",
      error: {
        code: "generated_asset_not_attached",
        message: "Generated, but not attached",
        correlationId: "correlation-1",
      },
      recovery: { kind: "attach_generated_asset", jobId, canvasId },
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
      timestamp: "2026-08-20T00:00:01.000Z",
    });
    listener?.({
      type: "run.failed",
      runId: "run_123",
      error: { code: "run_failed", message: "Agent run failed." },
      timestamp: "2026-08-20T00:00:02.000Z",
    });

    await waitFor(() => expect(saveMessageMock).toHaveBeenCalledTimes(1));
    expect(saveMessageMock).toHaveBeenLastCalledWith(
      "token_abc",
      "session-real",
      expect.objectContaining({
        role: "user",
        content: "generate and attach",
      }),
    );
  });

  it("performs one assistant fallback save only after a server persistence failure signal", async () => {
    let listener: ((event: StreamEvent) => void) | undefined;
    mockWs.onEvent = vi.fn((callback) => {
      listener = callback;
      return () => {};
    });
    render(
      <ToastProvider>
        <TierLimitToastProvider>
          <ChatSidebar
            accessToken="token_abc"
            canvasId="canvas-1"
            open
            onToggle={() => {}}
            ws={mockWs}
          />
        </TierLimitToastProvider>
      </ToastProvider>,
    );

    const input = await screen.findByPlaceholderText(/start with an idea/i);
    await userEvent.type(input, "save fallback{Enter}");
    await waitFor(() => expect(listener).toBeDefined());
    listener?.({
      type: "message.delta",
      runId: "run_123",
      messageId: "message-1",
      delta: "Assistant response.",
      timestamp: "2026-08-20T00:00:00.000Z",
    });
    listener?.({
      type: "assistant.persistence_failed",
      runId: "run_123",
      timestamp: "2026-08-20T00:00:01.000Z",
    });
    listener?.({
      type: "assistant.persistence_failed",
      runId: "run_123",
      timestamp: "2026-08-20T00:00:02.000Z",
    });

    await waitFor(() => expect(saveMessageMock).toHaveBeenCalledTimes(2));
    expect(saveMessageMock).toHaveBeenLastCalledWith(
      "token_abc",
      "session-real",
      expect.objectContaining({
        role: "assistant",
        content: "Assistant response.",
      }),
    );
  });

  it("reuses the acknowledged run listener when reconnect reloads no messages", async () => {
    const listeners: Array<(event: StreamEvent) => void> = [];
    mockWs.onEvent = vi.fn((callback) => {
      listeners.push(callback);
      return () => {};
    });
    render(
      <ToastProvider>
        <TierLimitToastProvider>
          <ChatSidebar
            accessToken="token_abc"
            canvasId="canvas-1"
            open
            onToggle={() => {}}
            ws={mockWs}
          />
        </TierLimitToastProvider>
      </ToastProvider>,
    );

    const input = await screen.findByPlaceholderText(/start with an idea/i);
    await userEvent.type(input, "resume fallback{Enter}");
    await waitFor(() => expect(listeners).toHaveLength(1));
    await waitFor(() => expect(mockWs.resumeCanvas).toHaveBeenCalled());

    const resume = vi.mocked(mockWs.resumeCanvas).mock.calls.at(-1)?.[1];
    resume?.({
      type: "command.ack",
      action: "canvas.resume",
      payload: {
        activeRunId: "run_123",
        activeRunSessionId: "session-real",
      },
    });
    // reloadMessages deliberately resolves with no rows: the original stream
    // listener and placeholder must remain the sole owners of this run.
    expect(fetchMessagesMock).toHaveBeenLastCalledWith(
      "token_abc",
      "session-real",
    );
    expect(listeners).toHaveLength(1);

    listeners[0]?.({
      type: "message.delta",
      runId: "run_123",
      messageId: "message-1",
      delta: "Replayed exactly once.",
      timestamp: "2026-08-20T00:00:01.000Z",
    });

    await waitFor(() =>
      expect(screen.getAllByText("Replayed exactly once.")).toHaveLength(1),
    );
  });

  it("keeps an in-flight assistant placeholder when reconnect reload omits it", async () => {
    const listeners: Array<(event: StreamEvent) => void> = [];
    mockWs.onEvent = vi.fn((callback) => {
      listeners.push(callback);
      return () => {};
    });
    const view = render(
      <ToastProvider>
        <TierLimitToastProvider>
          <ChatSidebar
            accessToken="token_abc"
            canvasId="canvas-1"
            open
            onToggle={() => {}}
            ws={mockWs}
          />
        </TierLimitToastProvider>
      </ToastProvider>,
    );

    const input = await screen.findByPlaceholderText(/start with an idea/i);
    await userEvent.type(input, "preserve placeholder{Enter}");
    await waitFor(() => expect(listeners).toHaveLength(1));
    fetchMessagesMock.mockResolvedValueOnce({
      messages: [
        {
          id: "persisted-user",
          role: "user",
          content: "persisted",
          contentBlocks: [{ type: "text", text: "persisted" }],
          createdAt: "2026-08-20T00:00:00.000Z",
        },
      ],
    });

    mockWs.connected = false;
    view.rerender(
      <ToastProvider>
        <TierLimitToastProvider>
          <ChatSidebar
            accessToken="token_abc"
            canvasId="canvas-1"
            open
            onToggle={() => {}}
            ws={mockWs}
          />
        </TierLimitToastProvider>
      </ToastProvider>,
    );
    mockWs.connected = true;
    view.rerender(
      <ToastProvider>
        <TierLimitToastProvider>
          <ChatSidebar
            accessToken="token_abc"
            canvasId="canvas-1"
            open
            onToggle={() => {}}
            ws={mockWs}
          />
        </TierLimitToastProvider>
      </ToastProvider>,
    );
    await waitFor(() => expect(mockWs.resumeCanvas).toHaveBeenCalledTimes(2));

    listeners[0]?.({
      type: "message.delta",
      runId: "run_123",
      messageId: "message-1",
      delta: "Still streaming.",
      timestamp: "2026-08-20T00:00:01.000Z",
    });
    await waitFor(() =>
      expect(screen.getAllByText("Still streaming.")).toHaveLength(1),
    );
  });

  it("saves a session-correlated terminal recovery marker after remount", async () => {
    const listeners: Array<(event: StreamEvent) => void> = [];
    mockWs.onEvent = vi.fn((callback) => {
      listeners.push(callback);
      return () => {};
    });
    render(
      <ToastProvider>
        <TierLimitToastProvider>
          <ChatSidebar
            accessToken="token_abc"
            canvasId="canvas-1"
            open
            onToggle={() => {}}
            ws={mockWs}
          />
        </TierLimitToastProvider>
      </ToastProvider>,
    );

    await waitFor(() => expect(mockWs.resumeCanvas).toHaveBeenCalled());
    const resume = vi.mocked(mockWs.resumeCanvas).mock.calls.at(-1)?.[1];
    resume?.({
      type: "command.ack",
      action: "canvas.resume",
      payload: { activeRunId: null, replayed: 1 },
    });
    await waitFor(() => expect(listeners).toHaveLength(1));
    listeners[0]?.({
      type: "assistant.persistence_failed",
      runId: "run-remounted",
      sessionId: "session-real",
      assistant: {
        content: "Recovered after remount.",
        contentBlocks: [{ type: "text", text: "Recovered after remount." }],
      },
      timestamp: "2026-08-20T00:00:01.000Z",
    });

    await waitFor(() =>
      expect(saveMessageMock).toHaveBeenCalledWith(
        "token_abc",
        "session-real",
        expect.objectContaining({
          role: "assistant",
          content: "Recovered after remount.",
        }),
      ),
    );
  });

  it("does not revive an active run owned by a different chat session", async () => {
    const listeners: Array<(event: StreamEvent) => void> = [];
    mockWs.onEvent = vi.fn((callback) => {
      listeners.push(callback);
      return () => {};
    });
    render(
      <ToastProvider>
        <TierLimitToastProvider>
          <ChatSidebar
            accessToken="token_abc"
            canvasId="canvas-1"
            open
            onToggle={() => {}}
            ws={mockWs}
          />
        </TierLimitToastProvider>
      </ToastProvider>,
    );

    await waitFor(() => expect(mockWs.resumeCanvas).toHaveBeenCalled());
    const resume = vi.mocked(mockWs.resumeCanvas).mock.calls.at(-1)?.[1];
    resume?.({
      type: "command.ack",
      action: "canvas.resume",
      payload: {
        activeRunId: "run-other-session",
        activeRunSessionId: "session-other",
        replayed: 1,
      },
    });

    await waitFor(() =>
      expect(screen.getByText("试试这些 Loomic Skills")).toBeInTheDocument(),
    );
    expect(listeners).toHaveLength(1);
    listeners[0]?.({
      type: "run.completed",
      runId: "run-other-session",
      timestamp: "2026-08-20T00:00:01.000Z",
    });
    expect(saveMessageMock).not.toHaveBeenCalled();
  });

  it("persists a known assistant response when a terminal replay resumes without an active run", async () => {
    const listeners: Array<(event: StreamEvent) => void> = [];
    mockWs.onEvent = vi.fn((callback) => {
      listeners.push(callback);
      return () => {};
    });
    const view = render(
      <ToastProvider>
        <TierLimitToastProvider>
          <ChatSidebar
            accessToken="token_abc"
            canvasId="canvas-1"
            open
            onToggle={() => {}}
            ws={mockWs}
          />
        </TierLimitToastProvider>
      </ToastProvider>,
    );

    const input = await screen.findByPlaceholderText(/start with an idea/i);
    await userEvent.type(input, "resume terminal fallback{Enter}");
    await waitFor(() => expect(listeners).toHaveLength(1));
    listeners[0]?.({
      type: "message.delta",
      runId: "run_123",
      messageId: "message-1",
      delta: "Recovered assistant response.",
      timestamp: "2026-08-20T00:00:00.000Z",
    });

    mockWs.connected = false;
    view.rerender(
      <ToastProvider>
        <TierLimitToastProvider>
          <ChatSidebar
            accessToken="token_abc"
            canvasId="canvas-1"
            open
            onToggle={() => {}}
            ws={mockWs}
          />
        </TierLimitToastProvider>
      </ToastProvider>,
    );
    mockWs.connected = true;
    view.rerender(
      <ToastProvider>
        <TierLimitToastProvider>
          <ChatSidebar
            accessToken="token_abc"
            canvasId="canvas-1"
            open
            onToggle={() => {}}
            ws={mockWs}
          />
        </TierLimitToastProvider>
      </ToastProvider>,
    );

    await waitFor(() => expect(mockWs.resumeCanvas).toHaveBeenCalledTimes(2));
    const resume = vi.mocked(mockWs.resumeCanvas).mock.calls.at(-1)?.[1];
    resume?.({
      type: "command.ack",
      action: "canvas.resume",
      payload: { activeRunId: null, replayed: 2 },
    });
    await waitFor(() => expect(listeners).toHaveLength(2));

    listeners[1]?.({
      type: "message.delta",
      runId: "run_123",
      messageId: "message-1",
      delta: " tail",
      timestamp: "2026-08-20T00:00:00.500Z",
    });
    await waitFor(() =>
      expect(
        screen.getAllByText("Recovered assistant response. tail"),
      ).toHaveLength(1),
    );

    listeners[1]?.({
      type: "assistant.persistence_failed",
      runId: "run_123",
      timestamp: "2026-08-20T00:00:01.000Z",
    });
    listeners[1]?.({
      type: "run.completed",
      runId: "run_123",
      timestamp: "2026-08-20T00:00:02.000Z",
    });

    await waitFor(() => expect(saveMessageMock).toHaveBeenCalledTimes(2));
    expect(saveMessageMock).toHaveBeenLastCalledWith(
      "token_abc",
      "session-real",
      expect.objectContaining({
        role: "assistant",
        content: "Recovered assistant response. tail",
      }),
    );
  });

  it("does not persist a replayed terminal marker for an unrelated completed run", async () => {
    const listeners: Array<(event: StreamEvent) => void> = [];
    mockWs.onEvent = vi.fn((callback) => {
      listeners.push(callback);
      return () => {};
    });
    render(
      <ToastProvider>
        <TierLimitToastProvider>
          <ChatSidebar
            accessToken="token_abc"
            canvasId="canvas-1"
            open
            onToggle={() => {}}
            ws={mockWs}
          />
        </TierLimitToastProvider>
      </ToastProvider>,
    );

    await waitFor(() => expect(mockWs.resumeCanvas).toHaveBeenCalled());
    const resume = vi.mocked(mockWs.resumeCanvas).mock.calls.at(-1)?.[1];
    resume?.({
      type: "command.ack",
      action: "canvas.resume",
      payload: { activeRunId: null, replayed: 2 },
    });
    await waitFor(() => expect(listeners).toHaveLength(1));

    listeners[0]?.({
      type: "assistant.persistence_failed",
      runId: "completed_elsewhere",
      timestamp: "2026-08-20T00:00:01.000Z",
    });
    listeners[0]?.({
      type: "run.completed",
      runId: "completed_elsewhere",
      timestamp: "2026-08-20T00:00:02.000Z",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(saveMessageMock).not.toHaveBeenCalled();
  });
});
