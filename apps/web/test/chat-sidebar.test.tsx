// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import type { StreamEvent } from "@loomic/shared";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatSidebar } from "../src/components/chat-sidebar";
import { TierLimitToastProvider } from "../src/components/credits/tier-limit-toast";
import { ToastProvider } from "../src/components/toast";
import { mapServerMessages } from "../src/hooks/use-chat-sessions";
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

  it("does not insert Agent media artifacts through browser callbacks", async () => {
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
          url: "https://example.com/generated.png",
          mimeType: "image/png",
          width: 512,
          height: 512,
        },
      ],
      timestamp: "2026-08-20T00:00:00.000Z",
    });

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

  it("persists failed attachment metadata when the Agent run terminates", async () => {
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

    await waitFor(() => expect(saveMessageMock).toHaveBeenCalledTimes(2));
    expect(saveMessageMock).toHaveBeenLastCalledWith(
      "token_abc",
      "session-real",
      expect.objectContaining({
        role: "assistant",
        contentBlocks: expect.arrayContaining([
          expect.objectContaining({
            type: "tool",
            status: "failed",
            error: expect.objectContaining({
              code: "generated_asset_not_attached",
            }),
            recovery: expect.objectContaining({
              kind: "attach_generated_asset",
              jobId,
              canvasId,
            }),
            artifacts: [expect.objectContaining({ type: "image" })],
          }),
        ]),
      }),
    );
  });
});
