// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import type { StreamEvent } from "@loomic/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  screen,
  render as testingRender,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatSidebar } from "../src/components/chat-sidebar";
import { TierLimitToastProvider } from "../src/components/credits/tier-limit-toast";
import { ToastProvider } from "../src/components/toast";
import {
  mapServerMessages,
  mergeMessagePages,
  mergeReloadedMessages,
} from "../src/hooks/use-chat-sessions";
import type { WebSocketHandle } from "../src/hooks/use-websocket";
import { createAgentRunController } from "../src/lib/agent-run-controller";
import { ApiApplicationError } from "../src/lib/api-client";
import { queryKeys } from "../src/lib/query/keys";

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
  ownerContext,
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
  ownerContext: { userId: "user-1", workspaceId: "workspace-1" },
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
vi.mock("../src/lib/auth-context", () => ({
  useAuth: () => ({
    user: { id: ownerContext.userId },
    session: { access_token: "token_abc" },
  }),
}));
vi.mock("../src/lib/api/viewer", () => ({
  fetchViewer: vi.fn(async () => ({
    profile: {
      id: ownerContext.userId,
      email: "u@example.com",
      displayName: "U",
      avatarUrl: null,
    },
    workspace: {
      id: ownerContext.workspaceId,
      name: "W",
      type: "personal",
      ownerUserId: ownerContext.userId,
    },
    membership: {
      workspaceId: ownerContext.workspaceId,
      userId: ownerContext.userId,
      role: "owner",
    },
  })),
}));
vi.mock("../src/lib/api/chat", () => ({
  fetchChatSessionsPage: vi.fn(
    async (
      token: string,
      canvasId: string,
      page: { cursor?: string; limit?: number },
    ) => {
      const result = await fetchSessionsMock(token, canvasId, page);
      return {
        items: result.sessions,
        nextCursor: result.nextCursor ?? null,
      };
    },
  ),
  fetchChatMessagesPage: vi.fn(
    async (
      token: string,
      sessionId: string,
      page: { cursor?: string; limit?: number },
    ) => {
      const result = await fetchMessagesMock(token, sessionId, page);
      return {
        items: result.messages,
        nextCursor: result.nextCursor ?? null,
      };
    },
  ),
}));
vi.mock("../src/lib/api/models", () => ({
  fetchAgentModels: fetchModelsMock,
  fetchImageModels: fetchImageModelsMock,
  fetchVideoModels: vi.fn(async () => ({ models: [] })),
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
    cancelRun: vi.fn(() => true),
    onEvent: vi.fn(() => () => {}),
    registerRPC: vi.fn(() => () => {}),
    resumeCanvas: vi.fn(),
  };
}

describe("ChatSidebar", () => {
  it("reuses the user message UUID for optimistic rendering and persistence", async () => {
    const randomUUID = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("11111111-1111-4111-8111-111111111111")
      .mockReturnValueOnce("22222222-2222-4222-8222-222222222222");
    const ws = createMockWs();
    render(
      <ToastProvider>
        <TierLimitToastProvider>
          <ChatSidebar
            accessToken="token_abc"
            canvasId="canvas-1"
            open
            onToggle={() => {}}
            ws={ws}
          />
        </TierLimitToastProvider>
      </ToastProvider>,
    );

    const input = await screen.findByPlaceholderText(/start with an idea/i);
    await userEvent.type(input, "stable user message{Enter}");

    await waitFor(() =>
      expect(saveMessageMock).toHaveBeenCalledWith(
        "token_abc",
        "session-real",
        expect.objectContaining({
          id: "11111111-1111-4111-8111-111111111111",
          role: "user",
        }),
      ),
    );
    await waitFor(() =>
      expect(
        document.querySelector(
          '[data-message-id="11111111-1111-4111-8111-111111111111"]',
        ),
      ).toBeInTheDocument(),
    );
    expect(randomUUID).toHaveBeenCalledTimes(2);
    expect(ws.startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        clientRequestId: "22222222-2222-4222-8222-222222222222",
      }),
      expect.anything(),
    );
  });
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

  it("prepends older durable pages while preserving chronological order and unique IDs", () => {
    const message = (id: string) => ({
      id,
      role: "user" as const,
      content: id,
      contentBlocks: [{ type: "text" as const, text: id }],
      toolActivities: [],
      createdAt: "2026-08-22T00:00:00.000Z",
    });
    expect(
      mergeMessagePages([
        { items: [message("m3"), message("m4")] },
        { items: [message("m1"), message("m2"), message("m3")] },
      ]).map((item) => item.id),
    ).toEqual(["m1", "m2", "m3", "m4"]);
  });

  let mockWs: WebSocketHandle;

  beforeEach(() => {
    ownerContext.userId = "user-1";
    ownerContext.workspaceId = "workspace-1";
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

  it("isolates chat controller state before a canvas owner changes", async () => {
    fetchSessionsMock.mockImplementation(async (_token, canvasId) => ({
      sessions: [
        {
          id: canvasId === "canvas-1" ? "session-old" : "session-new",
          title: canvasId === "canvas-1" ? "Old Chat" : "New Chat",
          updatedAt: "2026-03-24T00:00:00.000Z",
        },
      ],
    }));
    fetchMessagesMock.mockImplementation(async (_token, sessionId) => ({
      messages:
        sessionId === "session-old"
          ? [serverMessage("old-message", "old owner message")]
          : [],
    }));

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
    expect(
      await screen.findByText("old owner message", {}, { timeout: 3_000 }),
    ).toBeInTheDocument();
    await userEvent.type(
      screen.getByPlaceholderText(/start with an idea/i),
      "old pending message{Enter}",
    );
    expect(await screen.findByText("old pending message")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "停止运行" }),
    ).toBeInTheDocument();
    const callsBeforeNavigation = fetchMessagesMock.mock.calls.length;

    view.rerender(
      <ToastProvider>
        <TierLimitToastProvider>
          <ChatSidebar
            accessToken="token_abc"
            canvasId="canvas-2"
            open
            onToggle={() => {}}
            ws={mockWs}
          />
        </TierLimitToastProvider>
      </ToastProvider>,
    );

    expect(screen.queryByText("old owner message")).toBeNull();
    expect(screen.queryByText("old pending message")).toBeNull();
    expect(screen.queryByRole("button", { name: "停止运行" })).toBeNull();
    await waitFor(() =>
      expect(fetchMessagesMock).toHaveBeenCalledWith(
        "token_abc",
        "session-new",
        { cursor: undefined, limit: 30 },
      ),
    );
    expect(
      fetchMessagesMock.mock.calls
        .slice(callsBeforeNavigation)
        .some(([, sessionId]) => sessionId === "session-old"),
    ).toBe(false);

    const input = screen.getByPlaceholderText(/start with an idea/i);
    await userEvent.type(input, "new owner message{Enter}");
    await waitFor(() =>
      expect(saveMessageMock).toHaveBeenCalledWith(
        "token_abc",
        "session-new",
        expect.objectContaining({ role: "user" }),
      ),
    );
    await waitFor(() =>
      expect(mockWs.resumeCanvas).toHaveBeenCalledWith(
        "canvas-2",
        expect.any(Function),
      ),
    );
  });

  it("rebuilds the same live assistant after a real unmount and remount", async () => {
    let socketListener: ((event: StreamEvent) => void) | undefined;
    const ws = createMockWs();
    ws.onEvent = vi.fn((listener) => {
      socketListener = listener;
      return vi.fn();
    });
    const controller = createAgentRunController({
      canvasId: "canvas-1",
      ws,
    });
    const client = createTestQueryClient();
    const sidebar = (
      <ToastProvider>
        <TierLimitToastProvider>
          <ChatSidebar
            accessToken="token_abc"
            canvasId="canvas-1"
            open
            onToggle={() => {}}
            runController={controller}
            ws={ws}
          />
        </TierLimitToastProvider>
      </ToastProvider>
    );

    const first = render(sidebar, client);
    await screen.findByPlaceholderText(/start with an idea/i);
    await waitFor(() =>
      expect(fetchMessagesMock).toHaveBeenCalledWith(
        "token_abc",
        "session-real",
        expect.anything(),
      ),
    );
    act(() => {
      controller.startRun({
        runId: "run-remount",
        sessionId: "session-real",
        assistantId: "assistant-remount",
      });
      socketListener?.({
        type: "message.delta",
        runId: "run-remount",
        messageId: "message-remount",
        delta: "before ",
        timestamp: "2026-08-22T00:00:00.000Z",
      });
    });
    expect(await screen.findByText("before")).toBeInTheDocument();

    first.unmount();
    act(() => {
      socketListener?.({
        type: "message.delta",
        runId: "run-remount",
        messageId: "message-remount",
        delta: "after",
        timestamp: "2026-08-22T00:00:01.000Z",
      });
      socketListener?.({
        type: "billing.error",
        runId: "run-remount",
        code: "insufficient_credits",
        message: "Not enough credits",
        currentBalance: 1,
        requiredAmount: 2,
        plan: "free",
        dailyClaimed: false,
        timestamp: "2026-08-22T00:00:02.000Z",
      });
      socketListener?.({
        type: "run.canceled",
        runId: "run-remount",
        timestamp: "2026-08-22T00:00:03.000Z",
      });
    });

    render(sidebar, client);
    expect(await screen.findByText("before after")).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { name: "Not Enough Credits" }),
    ).toBeInTheDocument();
    expect(
      document.querySelector('[data-message-id="assistant-remount"]'),
    ).toBeInTheDocument();
    expect(ws.onEvent).toHaveBeenCalledOnce();
    await waitFor(() => expect(controller.getRuns()).toHaveLength(0));
    controller.dispose();
  });

  it("isolates the active session when the user or workspace owner changes", async () => {
    const client = createTestQueryClient();
    fetchSessionsMock.mockImplementation(async () => ({
      sessions: [
        {
          id: `session-${ownerContext.userId}-${ownerContext.workspaceId}`,
          title: "Owned Chat",
          updatedAt: "2026-03-24T00:00:00.000Z",
        },
      ],
    }));
    const sidebar = () => (
      <ToastProvider>
        <TierLimitToastProvider>
          <ChatSidebar
            accessToken="token_abc"
            canvasId="shared-canvas"
            open
            onToggle={() => {}}
            ws={mockWs}
          />
        </TierLimitToastProvider>
      </ToastProvider>
    );
    const view = render(sidebar(), client);
    await waitFor(() =>
      expect(fetchMessagesMock).toHaveBeenCalledWith(
        "token_abc",
        "session-user-1-workspace-1",
        { cursor: undefined, limit: 30 },
      ),
    );

    ownerContext.userId = "user-2";
    ownerContext.workspaceId = "workspace-2";
    const callsBeforeUserChange = fetchMessagesMock.mock.calls.length;
    view.rerender(sidebar());
    await waitFor(() =>
      expect(fetchMessagesMock).toHaveBeenCalledWith(
        "token_abc",
        "session-user-2-workspace-2",
        { cursor: undefined, limit: 30 },
      ),
    );
    expect(
      fetchMessagesMock.mock.calls
        .slice(callsBeforeUserChange)
        .some(([, id]) => id === "session-user-1-workspace-1"),
    ).toBe(false);

    ownerContext.workspaceId = "workspace-3";
    client.setQueryData(queryKeys.viewer("user-2"), {
      profile: {
        id: "user-2",
        email: "u@example.com",
        displayName: "U",
        avatarUrl: null,
      },
      workspace: {
        id: "workspace-3",
        name: "W",
        type: "personal",
        ownerUserId: "user-2",
      },
      membership: {
        workspaceId: "workspace-3",
        userId: "user-2",
        role: "owner",
      },
    });
    const callsBeforeWorkspaceChange = fetchMessagesMock.mock.calls.length;
    await waitFor(() =>
      expect(fetchMessagesMock).toHaveBeenCalledWith(
        "token_abc",
        "session-user-2-workspace-3",
        { cursor: undefined, limit: 30 },
      ),
    );
    expect(
      fetchMessagesMock.mock.calls
        .slice(callsBeforeWorkspaceChange)
        .some(([, id]) => id === "session-user-2-workspace-2"),
    ).toBe(false);
  });

  it("discards an initial session created for a previous canvas owner", async () => {
    let resolveOldSession!: (value: {
      session: { id: string; title: string; updatedAt: string };
    }) => void;
    createSessionMock.mockImplementation((_token: string, canvasId: string) =>
      canvasId === "canvas-old"
        ? new Promise((resolve) => {
            resolveOldSession = resolve;
          })
        : Promise.resolve({
            session: {
              id: "session-created-new",
              title: "New",
              updatedAt: "2026-03-24T00:00:00.000Z",
            },
          }),
    );
    fetchSessionsMock.mockImplementation(async (_token, canvasId) => ({
      sessions:
        canvasId === "canvas-old"
          ? []
          : [
              {
                id: "session-new",
                title: "New Chat",
                updatedAt: "2026-03-24T00:00:00.000Z",
              },
            ],
    }));
    const sidebar = (canvasId: string) => (
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
      </ToastProvider>
    );
    const view = render(sidebar("canvas-old"));
    await waitFor(() =>
      expect(createSessionMock).toHaveBeenCalledWith("token_abc", "canvas-old"),
    );
    view.rerender(sidebar("canvas-new"));
    await waitFor(() =>
      expect(fetchMessagesMock).toHaveBeenCalledWith(
        "token_abc",
        "session-new",
        { cursor: undefined, limit: 30 },
      ),
    );
    await act(async () => {
      resolveOldSession({
        session: {
          id: "session-old-created",
          title: "Old",
          updatedAt: "2026-03-24T00:00:00.000Z",
        },
      });
    });
    expect(
      fetchMessagesMock.mock.calls.some(
        ([, id]) => id === "session-old-created",
      ),
    ).toBe(false);
  });

  it("loads older chat sessions from the next durable page", async () => {
    fetchSessionsMock
      .mockResolvedValueOnce({
        sessions: [
          {
            id: "session-real",
            title: "Recent Chat",
            updatedAt: "2026-03-24T00:00:00.000Z",
          },
        ],
        nextCursor: "older-page",
      })
      .mockResolvedValueOnce({
        sessions: [
          {
            id: "session-older",
            title: "Older Chat",
            updatedAt: "2026-03-23T00:00:00.000Z",
          },
        ],
        nextCursor: null,
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

    await userEvent.click(
      await screen.findByRole("button", { name: /recent chat/i }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Load older chats" }),
    );

    expect(await screen.findByText("Older Chat")).toBeInTheDocument();
    expect(fetchSessionsMock).toHaveBeenLastCalledWith(
      "token_abc",
      "canvas-1",
      { cursor: "older-page", limit: 20 },
    );
  });

  it("refreshes the exact durable session catalog after deletion", async () => {
    const remainingSession = {
      id: "session-remaining",
      title: "Remaining Chat",
      updatedAt: "2026-03-23T00:00:00.000Z",
    };
    fetchSessionsMock
      .mockResolvedValueOnce({
        sessions: [
          {
            id: "session-real",
            title: "Existing Chat",
            updatedAt: "2026-03-24T00:00:00.000Z",
          },
          remainingSession,
        ],
      })
      .mockResolvedValue({ sessions: [remainingSession] });
    deleteSessionMock.mockResolvedValue(undefined);

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

    await userEvent.click(
      await screen.findByRole("button", { name: /existing chat/i }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Delete Existing Chat" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "删除" }));

    await waitFor(() => expect(fetchSessionsMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Existing Chat")).toBeNull();
  });

  it("recovers only the sessions query from an invalid cursor at the first page", async () => {
    fetchSessionsMock.mockImplementation(
      async (_token, _canvasId, page: { cursor?: string }) => {
        if (page.cursor === "stale-sessions") {
          throw new ApiApplicationError("invalid_cursor", "stale");
        }
        return {
          sessions: [
            {
              id: "session-real",
              title: "Recent Chat",
              updatedAt: "2026-03-24T00:00:00.000Z",
            },
          ],
          nextCursor:
            fetchSessionsMock.mock.calls.length === 1 ? "stale-sessions" : null,
        };
      },
    );
    const client = createTestQueryClient();
    client.setQueryData(["unrelated-catalog"], { preserved: true });
    const cancelSpy = vi.spyOn(client, "cancelQueries");
    const removeSpy = vi.spyOn(client, "removeQueries");

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
      client,
    );

    await userEvent.click(
      await screen.findByRole("button", { name: /recent chat/i }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Load older chats" }),
    );

    await waitFor(() => expect(fetchSessionsMock).toHaveBeenCalledTimes(3));
    expect(fetchSessionsMock).toHaveBeenLastCalledWith(
      "token_abc",
      "canvas-1",
      { cursor: undefined, limit: 20 },
    );
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(cancelSpy.mock.invocationCallOrder[0]).toBeLessThan(
      removeSpy.mock.invocationCallOrder[0] ?? 0,
    );
    expect(client.getQueryData(["unrelated-catalog"])).toEqual({
      preserved: true,
    });
  });

  it("preserves live overlay and unrelated cache during message cursor recovery", async () => {
    fetchMessagesMock.mockImplementation(
      async (_token, _sessionId, page: { cursor?: string }) => {
        if (page.cursor === "stale-messages") {
          throw new ApiApplicationError("invalid_cursor", "stale");
        }
        return {
          messages: [serverMessage("durable-recent", "recent")],
          nextCursor:
            fetchMessagesMock.mock.calls.length === 1 ? "stale-messages" : null,
        };
      },
    );
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("11111111-1111-4111-8111-111111111111")
      .mockReturnValueOnce("22222222-2222-4222-8222-222222222222");
    const client = createTestQueryClient();
    client.setQueryData(["unrelated-catalog"], { preserved: true });
    const cancelSpy = vi.spyOn(client, "cancelQueries");
    const removeSpy = vi.spyOn(client, "removeQueries");

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
      client,
    );

    const input = await screen.findByPlaceholderText(/start with an idea/i);
    await userEvent.type(input, "pending message{Enter}");
    await userEvent.click(
      await screen.findByRole("button", { name: "Load older messages" }),
    );

    await waitFor(() => expect(fetchMessagesMock).toHaveBeenCalledTimes(3));
    expect(fetchMessagesMock).toHaveBeenLastCalledWith(
      "token_abc",
      "session-real",
      { cursor: undefined, limit: 30 },
    );
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(
      document.querySelectorAll(
        '[data-message-id="11111111-1111-4111-8111-111111111111"]',
      ),
    ).toHaveLength(1);
    expect(client.getQueryData(["unrelated-catalog"])).toEqual({
      preserved: true,
    });
  });

  it("does not loop when first-page session cursor recovery also fails", async () => {
    fetchSessionsMock.mockImplementation(
      async (_token, _canvasId, page: { cursor?: string }) => {
        if (fetchSessionsMock.mock.calls.length > 1) {
          throw new ApiApplicationError("invalid_cursor", "stale");
        }
        return {
          sessions: [
            {
              id: "session-real",
              title: "Recent Chat",
              updatedAt: "2026-03-24T00:00:00.000Z",
            },
          ],
          nextCursor: "stale-sessions",
        };
      },
    );

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

    await userEvent.click(
      await screen.findByRole("button", { name: /recent chat/i }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Load older chats" }),
    );

    await waitFor(() => expect(fetchSessionsMock).toHaveBeenCalledTimes(3));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchSessionsMock).toHaveBeenCalledTimes(3);
  });

  it("shows safe session and message errors with scoped retry actions", async () => {
    fetchSessionsMock
      .mockRejectedValueOnce(new ApiApplicationError("upstream", "secret"))
      .mockResolvedValueOnce({
        sessions: [
          {
            id: "session-real",
            title: "Recovered Chat",
            updatedAt: "2026-03-24T00:00:00.000Z",
          },
        ],
      });
    fetchMessagesMock
      .mockRejectedValueOnce(new ApiApplicationError("upstream", "secret"))
      .mockResolvedValueOnce({ messages: [] });

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

    expect(
      await screen.findByText("Unable to load chat history."),
    ).toBeInTheDocument();
    expect(screen.queryByText("secret")).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Retry chat history" }),
    );
    expect(
      await screen.findByRole("button", { name: /recovered chat/i }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("Unable to load messages."),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Retry messages" }),
    );
    await waitFor(() => expect(fetchMessagesMock).toHaveBeenCalledTimes(2));
    expect(fetchSessionsMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Unable to load messages.")).toBeNull();
  });

  it("reloads the exact session catalog after a successful title mutation", async () => {
    fetchSessionsMock
      .mockResolvedValueOnce({
        sessions: [
          {
            id: "session-real",
            title: "Existing Chat",
            updatedAt: "2026-03-24T00:00:00.000Z",
          },
        ],
      })
      .mockResolvedValue({
        sessions: [
          {
            id: "session-real",
            title: "Renamed Chat",
            updatedAt: "2026-03-25T00:00:00.000Z",
          },
        ],
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
    await userEvent.type(input, "Renamed Chat{Enter}");

    await waitFor(() =>
      expect(updateSessionTitleMock).toHaveBeenCalledTimes(1),
    );
    await waitFor(() => expect(fetchSessionsMock).toHaveBeenCalledTimes(2));
    expect(fetchSessionsMock).toHaveBeenLastCalledWith(
      "token_abc",
      "canvas-1",
      { cursor: undefined, limit: 20 },
    );
  });

  it("preserves the visible scroll anchor when older messages prepend", async () => {
    let scrollHeight = 100;
    fetchMessagesMock.mockImplementation(
      async (_token, _sessionId, page: { cursor?: string }) => {
        if (page.cursor === "older-page") {
          scrollHeight = 160;
          return {
            messages: [serverMessage("durable-older", "older")],
            nextCursor: null,
          };
        }
        return {
          messages: [serverMessage("durable-recent", "recent")],
          nextCursor: "older-page",
        };
      },
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
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

    const loadOlder = await screen.findByRole("button", {
      name: "Load older messages",
    });
    const viewport = loadOlder.closest(
      '[aria-live="polite"]',
    ) as HTMLDivElement;
    Object.defineProperty(viewport, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    viewport.scrollTop = 20;

    await userEvent.click(loadOlder);

    await waitFor(() => expect(viewport.scrollTop).toBe(80));
  });

  it("keeps live overlay unique and after chronological durable pages", async () => {
    fetchMessagesMock.mockImplementation(
      async (_token, _sessionId, page: { cursor?: string }) =>
        page.cursor === "older-page"
          ? {
              messages: [serverMessage("durable-older", "older")],
              nextCursor: null,
            }
          : {
              messages: [serverMessage("durable-recent", "recent")],
              nextCursor: "older-page",
            },
    );
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("11111111-1111-4111-8111-111111111111")
      .mockReturnValueOnce("22222222-2222-4222-8222-222222222222");

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
    await userEvent.type(input, "pending message{Enter}");
    await waitFor(() =>
      expect(document.querySelectorAll("[data-message-id]")).toHaveLength(3),
    );
    const liveIds = [...document.querySelectorAll("[data-message-id]")]
      .map((element) => element.getAttribute("data-message-id"))
      .filter((id) => id !== "durable-recent");
    await userEvent.click(
      await screen.findByRole("button", { name: "Load older messages" }),
    );

    await screen.findByText("older");
    const ids = [...document.querySelectorAll("[data-message-id]")].map(
      (element) => element.getAttribute("data-message-id"),
    );
    expect(ids).toEqual(["durable-older", "durable-recent", ...liveIds]);
    expect(new Set(liveIds).size).toBe(2);
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

  it("keeps a run active when the stop command cannot be sent", async () => {
    mockWs.cancelRun = vi.fn(() => false);
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
    await userEvent.type(input, "keep running{Enter}");
    await userEvent.click(
      await screen.findByRole("button", { name: "停止运行" }),
    );

    expect(mockWs.cancelRun).toHaveBeenCalledWith("run_123");
    expect(
      screen.getByRole("button", { name: "停止运行" }),
    ).toBeInTheDocument();
  });

  it("keeps the resumed server run active after replacing a mismatched waiter", async () => {
    let resumeAck: ((ack: unknown) => void) | undefined;
    mockWs.resumeCanvas = vi.fn((_canvasId, onAck) => {
      resumeAck = onAck;
    });
    const controller = createAgentRunController({
      canvasId: "canvas-1",
      ws: mockWs,
    });
    render(
      <ToastProvider>
        <TierLimitToastProvider>
          <ChatSidebar
            accessToken="token_abc"
            canvasId="canvas-1"
            open
            onToggle={() => {}}
            runController={controller}
            ws={mockWs}
          />
        </TierLimitToastProvider>
      </ToastProvider>,
    );

    const input = await screen.findByPlaceholderText(/start with an idea/i);
    await userEvent.type(input, "resume another session{Enter}");
    expect(
      await screen.findByRole("button", { name: "停止运行" }),
    ).toBeInTheDocument();

    await act(async () => {
      controller.requestResume();
      resumeAck?.({
        payload: {
          activeRunId: "run_123",
          activeRunSessionId: "session-server",
          replayGap: false,
        },
      });
      await Promise.resolve();
    });

    expect(controller.getRuns().get("run_123")?.sessionId).toBe(
      "session-server",
    );
    expect(
      screen.getByRole("button", { name: "停止运行" }),
    ).toBeInTheDocument();
    controller.dispose();
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
    const outstanding = {
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
    };
    let resolveStaleRefresh: ((value: typeof outstanding) => void) | undefined;
    fetchOutstandingGeneratedAssetAttachmentsMock
      .mockResolvedValueOnce(outstanding)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveStaleRefresh = resolve;
          }),
      );
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
    await waitFor(() =>
      expect(
        fetchOutstandingGeneratedAssetAttachmentsMock,
      ).toHaveBeenCalledTimes(2),
    );
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
    await act(async () => {
      resolveStaleRefresh?.(outstanding);
      await Promise.resolve();
    });
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
        id: "run_123",
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
      { cursor: undefined, limit: 30 },
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
          id: "run-remounted",
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
    await waitFor(() => expect(listeners).toHaveLength(1));

    listeners[0]?.({
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

    listeners[0]?.({
      type: "assistant.persistence_failed",
      runId: "run_123",
      timestamp: "2026-08-20T00:00:01.000Z",
    });
    listeners[0]?.({
      type: "run.completed",
      runId: "run_123",
      timestamp: "2026-08-20T00:00:02.000Z",
    });

    await waitFor(() => expect(saveMessageMock).toHaveBeenCalledTimes(2));
    expect(saveMessageMock).toHaveBeenLastCalledWith(
      "token_abc",
      "session-real",
      expect.objectContaining({
        id: "run_123",
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
function serverMessage(id: string, content: string) {
  return {
    id,
    role: "assistant" as const,
    content,
    contentBlocks: [{ type: "text" as const, text: content }],
    toolActivities: [],
    createdAt: "2026-03-24T00:00:00.000Z",
  };
}

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

function render(ui: ReactElement, client = createTestQueryClient()) {
  return testingRender(ui, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}
