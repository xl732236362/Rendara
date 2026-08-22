// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import type { StreamEvent } from "@loomic/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import CanvasPage from "../src/app/canvas/page";
import type { AgentRunController } from "../src/lib/agent-run-controller";
import { queryKeys } from "../src/lib/query/keys";

const runtime = vi.hoisted(() => ({
  listener: undefined as ((event: StreamEvent) => void) | undefined,
  resumeAck: undefined as ((ack: unknown) => void) | undefined,
  checkForTimedOutJobs: vi.fn(),
  saveMessage: vi.fn(),
  ws: {
    connected: true,
    onEvent: vi.fn((listener: (event: StreamEvent) => void) => {
      runtime.listener = listener;
      return vi.fn();
    }),
    resumeCanvas: vi.fn((_canvasId: string, onAck?: (ack: unknown) => void) => {
      runtime.resumeAck = onAck;
    }),
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams("id=canvas-1"),
}));
vi.mock("../src/lib/auth-context", () => ({
  useAuth: () => ({
    user: { id: "user-1" },
    session: { access_token: "token-1" },
    loading: false,
    signOut: vi.fn(),
  }),
}));
vi.mock("../src/hooks/use-websocket", () => ({
  useWebSocket: () => runtime.ws,
}));
vi.mock("../src/hooks/use-job-fallback-polling", () => ({
  useJobFallbackPolling: () => ({
    checkForTimedOutJobs: runtime.checkForTimedOutJobs,
  }),
}));
vi.mock("../src/lib/query/workspace-queries", () => ({
  useViewerQuery: () => ({ data: { workspace: { id: "workspace-1" } } }),
}));
vi.mock("../src/lib/server-api", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../src/lib/server-api")>();
  return {
    ...original,
    fetchCanvas: vi.fn(async () => ({
      canvas: {
        id: "canvas-1",
        name: "Canvas",
        projectId: "project-1",
        revision: 1,
        content: { elements: [], appState: {}, files: {} },
      },
    })),
    fetchProject: vi.fn(async () => ({
      project: { name: "Project", brand_kit_id: null },
    })),
    saveMessage: runtime.saveMessage,
  };
});

vi.mock("../src/components/chat-sidebar", () => ({
  ChatSidebar: ({
    onToggle,
    runController,
  }: {
    onToggle: () => void;
    runController: AgentRunController;
  }) => {
    useSyncExternalStore(runController.subscribe, () =>
      runController.getRuns(),
    );
    const text = [...runController.getRuns().values()]
      .flatMap((run) => run.contentBlocks)
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    return (
      <aside aria-label="chat-sidebar">
        <button onClick={onToggle} type="button">
          close chat
        </button>
        <span>{text}</span>
      </aside>
    );
  },
}));

vi.mock("../src/components/brand-kit-selector", () => ({
  BrandKitSelector: () => null,
}));
vi.mock("../src/components/canvas-bottom-bar", () => ({
  CanvasBottomBar: () => null,
}));
vi.mock("../src/components/canvas-empty-hint", () => ({
  CanvasEmptyHint: () => null,
}));
vi.mock("../src/components/canvas-files-panel", () => ({
  CanvasFilesPanel: () => null,
}));
vi.mock("../src/components/canvas-layers-panel", () => ({
  CanvasLayersPanel: () => null,
}));
vi.mock("../src/components/canvas-logo-menu", () => ({
  CanvasLogoMenu: () => null,
}));
vi.mock("../src/components/credits/credit-header-button", () => ({
  CreditHeaderButton: () => null,
}));
vi.mock("../src/components/editable-project-name", () => ({
  EditableProjectName: () => null,
}));
vi.mock("../src/components/canvas-editor", () => ({
  CanvasEditor: () => null,
}));
vi.mock("../src/components/loading-screen", () => ({
  LoadingScreen: () => <div>loading</div>,
}));

describe("Canvas page Agent run ownership", () => {
  beforeEach(() => {
    runtime.listener = undefined;
    runtime.resumeAck = undefined;
    runtime.saveMessage.mockReset();
    runtime.saveMessage.mockResolvedValue(undefined);
    runtime.ws.onEvent.mockClear();
    runtime.ws.resumeCanvas.mockClear();
    window.innerWidth = 1280;
  });

  afterEach(() => cleanup());

  it("keeps recovery alive while chat is closed and restores the retained result", async () => {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    render(
      <QueryClientProvider client={client}>
        <CanvasPage />
      </QueryClientProvider>,
    );

    expect(await screen.findByLabelText("chat-sidebar")).toBeInTheDocument();
    expect(runtime.ws.onEvent).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "close chat" }));
    expect(screen.queryByLabelText("chat-sidebar")).toBeNull();

    act(() => {
      runtime.listener?.({
        type: "assistant.persistence_failed",
        runId: "recovered-run",
        sessionId: "session-1",
        assistant: {
          content: "recovered",
          contentBlocks: [{ type: "text", text: "recovered" }],
        },
      } as StreamEvent);
      runtime.resumeAck?.({
        payload: { replayGap: true, activeRunSessionId: null },
      });
    });

    await waitFor(() => expect(runtime.saveMessage).toHaveBeenCalled());
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: queryKeys.workspace.canvas(
          "user-1",
          "workspace-1",
          "canvas-1",
        ),
        refetchType: "all",
      }),
    );

    act(() => {
      const controllerRunId = "run-retained";
      runtime.resumeAck?.({
        payload: {
          activeRunId: controllerRunId,
          activeRunSessionId: "session-1",
          replayGap: false,
        },
      });
      runtime.listener?.({
        type: "message.delta",
        runId: controllerRunId,
        delta: "background result",
      } as StreamEvent);
    });
    await userEvent.click(screen.getByRole("button", { name: "打开对话" }));
    expect(await screen.findByText("background result")).toBeInTheDocument();
    expect(runtime.ws.onEvent).toHaveBeenCalledOnce();
  });
});
