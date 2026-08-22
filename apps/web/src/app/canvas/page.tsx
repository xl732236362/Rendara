"use client";

import { useQueryClient } from "@tanstack/react-query";
import { MessageCircle } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { StreamEvent } from "@loomic/shared";
import { BrandKitSelector } from "../../components/brand-kit-selector";
import { CanvasBottomBar } from "../../components/canvas-bottom-bar";
import type {
  CanvasPersistenceHandle,
  CanvasSelectedElement,
} from "../../components/canvas-editor";
import { CanvasEditor } from "../../components/canvas-editor";
import { CanvasEmptyHint } from "../../components/canvas-empty-hint";
import { CanvasFilesPanel } from "../../components/canvas-files-panel";
import type { CanvasImageItem } from "../../components/canvas-image-picker";
import { CanvasLayersPanel } from "../../components/canvas-layers-panel";
import { CanvasLogoMenu } from "../../components/canvas-logo-menu";
import { ChatSidebar } from "../../components/chat-sidebar";
import { CreditHeaderButton } from "../../components/credits/credit-header-button";
import { EditableProjectName } from "../../components/editable-project-name";
import { LoadingScreen } from "../../components/loading-screen";
import { useJobFallbackPolling } from "../../hooks/use-job-fallback-polling";
import { useWebSocket } from "../../hooks/use-websocket";
import {
  type AgentRunController,
  createAgentRunController,
} from "../../lib/agent-run-controller";
import { useAuth } from "../../lib/auth-context";
import {
  createAuthExpiryHandler,
  registerApiAuthExpiryHandler,
} from "../../lib/auth-expiry";
import { queryKeys } from "../../lib/query/keys";
import { useViewerQuery } from "../../lib/query/workspace-queries";
import {
  ApiApplicationError,
  ApiAuthError,
  fetchCanvas,
  fetchProject,
  saveMessage,
} from "../../lib/server-api";

function CanvasPageContent() {
  const searchParams = useSearchParams();
  const canvasId = searchParams.get("id");
  const initialSessionId = searchParams.get("session") ?? undefined;
  // Capture prompt once — router.replace will strip it from URL, but the
  // value must survive for the auto-send effect in ChatSidebar.
  const [initialPrompt] = useState(
    () => searchParams.get("prompt") ?? undefined,
  );
  const { user, session, loading: authLoading, signOut } = useAuth();
  const router = useRouter();

  const [canvasData, setCanvasData] = useState<{
    id: string;
    name: string;
    projectId: string;
    revision: number;
    content: {
      elements: Record<string, unknown>[];
      appState: Record<string, unknown>;
      files: Record<string, Record<string, unknown>>;
    };
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pageLoading, setPageLoading] = useState(true);
  // Default chat open on desktop, closed on mobile/tablet to avoid blocking canvas
  const [chatOpen, setChatOpen] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.innerWidth >= 1024;
  });
  const [layersOpen, setLayersOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [brandKitId, setBrandKitId] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("Untitled");
  const [selectedCanvasElements, setSelectedCanvasElements] = useState<
    CanvasSelectedElement[]
  >([]);

  const excalidrawApiRef = useRef<any>(null);
  const canvasPersistenceRef = useRef<CanvasPersistenceHandle | null>(null);
  const [excalidrawApi, setExcalidrawApi] = useState<any>(null);

  const signOutRef = useRef(signOut);
  signOutRef.current = signOut;
  const routerRef = useRef(router);
  routerRef.current = router;

  // Stable callbacks for panel toggles to prevent re-renders of child components
  const handleOpenChat = useCallback(() => setChatOpen(true), []);
  const handleToggleChat = useCallback(() => setChatOpen((v) => !v), []);
  const handleToggleLayers = useCallback(() => {
    setLayersOpen((v) => !v);
    setFilesOpen(false);
  }, []);
  const handleToggleFiles = useCallback(() => {
    setFilesOpen((v) => !v);
    setLayersOpen(false);
  }, []);
  const handleCloseLayers = useCallback(() => setLayersOpen(false), []);
  const handleCloseFiles = useCallback(() => setFilesOpen(false), []);

  const accessToken = session?.access_token;
  const accessTokenRef = useRef(accessToken);
  accessTokenRef.current = accessToken;

  const getToken = useCallback(() => accessTokenRef.current ?? null, []);
  const handleAuthExpired = useMemo(
    () =>
      createAuthExpiryHandler({
        signOut: () => signOutRef.current(),
        navigateToLogin: (path) => routerRef.current.replace(path),
        getReturnTo: () =>
          `${window.location.pathname}${window.location.search}${window.location.hash}`,
        logger: console,
      }),
    [],
  );
  useEffect(
    () => registerApiAuthExpiryHandler(handleAuthExpired),
    [handleAuthExpired],
  );
  const ws = useWebSocket(getToken, { onAuthExpired: handleAuthExpired });
  const queryClient = useQueryClient();
  const viewer = useViewerQuery(user?.id, getToken);
  const chatOwnerRef = useRef({
    userId: user?.id,
    workspaceId: viewer.data?.workspace.id,
  });
  chatOwnerRef.current = {
    userId: user?.id,
    workspaceId: viewer.data?.workspace.id,
  };

  const handleApiReady = useCallback((api: any) => {
    excalidrawApiRef.current = api;
    setExcalidrawApi(api);
  }, []);

  const handlePersistenceReady = useCallback(
    (handle: CanvasPersistenceHandle | null) => {
      canvasPersistenceRef.current = handle;
    },
    [],
  );

  // Must be defined BEFORE useJobFallbackPolling which references it
  const handleCanvasSync = useCallback(
    async (event: Extract<StreamEvent, { type: "canvas.sync" }>) => {
      if (!canvasData || event.canvasId !== canvasData.id) return;
      try {
        await canvasPersistenceRef.current?.sync(event);
      } catch (err) {
        console.warn("[canvas.persistence] sync_failed", {
          canvasId: event.canvasId,
          revision: event.revision,
          ...(err instanceof ApiApplicationError
            ? {
                code: err.code,
                status: err.status,
                correlationId: err.correlationId,
              }
            : {
                code: "unknown_error",
                status: 0,
                correlationId: undefined,
              }),
        });
      }
    },
    [canvasData],
  );

  // Fallback polling for timed-out generation jobs.
  // When the agent's tool times out but the worker eventually succeeds,
  // the backend will have already inserted the element into the canvas.
  // This hook detects completion and triggers a canvas re-fetch.
  const { checkForTimedOutJobs } = useJobFallbackPolling({
    accessTokenRef,
    onJobSucceeded: useCallback((_jobId: string, _jobType: string) => {
      // The committed canvas.updated event is the only refresh authority.
    }, []),
  });

  const handleSessionChange = useCallback(
    (sessionId: string) => {
      if (!canvasId) return;
      // Update URL: set session param, remove prompt param to prevent re-send on refresh
      routerRef.current.replace(`/canvas?id=${canvasId}&session=${sessionId}`);
    },
    [canvasId],
  );

  const handleRequestCanvasImages = useCallback((): CanvasImageItem[] => {
    const api = excalidrawApiRef.current;
    if (!api) return [];
    const elements: any[] = api.getSceneElements() ?? [];
    const files: Record<string, any> = api.getFiles() ?? {};
    let idx = 0;
    return elements
      .filter((el: any) => el.type === "image" && !el.isDeleted && el.fileId)
      .map((el: any) => {
        idx++;
        const file = files[el.fileId];
        const dataURL = file?.dataURL ?? "";
        const title =
          el.customData?.title || el.customData?.label || `Image ${idx}`;
        return {
          kind: "canvas-image",
          id: el.id,
          name: title,
          thumbnailUrl: dataURL,
          assetId: el.id,
          url: dataURL,
          mimeType: file?.mimeType ?? "image/png",
        };
      });
  }, []);

  // Only re-fetch when canvasId changes or on initial auth resolution.
  // Token refreshes (e.g. tab switch back) should NOT trigger a reload —
  // we depend on user.id (stable string) instead of the user object ref.
  const userId = user?.id;

  useEffect(() => {
    if (authLoading) return;
    if (!userId) {
      routerRef.current.replace("/login");
      return;
    }
    const token = accessTokenRef.current;
    if (!canvasId || !token) return;

    setPageLoading(true);
    fetchCanvas(token, canvasId)
      .then((data) => {
        const c = data.canvas;
        setCanvasData({
          id: c.id,
          name: c.name,
          projectId: c.projectId,
          revision: c.revision,
          content: {
            elements: c.content.elements ?? [],
            appState: c.content.appState ?? {},
            files: (c.content as any).files ?? {},
          },
        });
        canvasPersistenceRef.current = null;
        setPageLoading(false);
        // Fetch project to get brand_kit_id and name
        fetchProject(token, c.projectId)
          .then((projectData) => {
            setBrandKitId(projectData.project.brand_kit_id);
            setProjectName(projectData.project.name ?? "Untitled");
          })
          .catch((err) =>
            console.warn("Failed to fetch project for brand kit:", err),
          );
      })
      .catch((err) => {
        if (err instanceof ApiAuthError) {
          handleAuthExpired();
          return;
        }
        setError("Failed to load canvas.");
        setPageLoading(false);
      });
    // Intentionally omitting accessTokenRef (stable ref) and signOutRef/routerRef
    // (ref wrappers) from deps — only re-run when auth resolves, user changes, or
    // canvasId changes. Token refresh (e.g. tab switch) must NOT trigger a reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, userId, canvasId, handleAuthExpired]);

  useEffect(() => {
    const reconcileOnFocus = () => {
      void canvasPersistenceRef.current?.reconcile("focus");
    };
    window.addEventListener("focus", reconcileOnFocus);
    return () => window.removeEventListener("focus", reconcileOnFocus);
  }, []);

  const previouslyConnectedRef = useRef(false);
  useEffect(() => {
    if (ws.connected && !previouslyConnectedRef.current) {
      void canvasPersistenceRef.current?.reconcile("reconnect");
    }
    previouslyConnectedRef.current = ws.connected;
  }, [ws.connected]);

  const handleStreamEvent = useCallback(
    (event: StreamEvent) => {
      checkForTimedOutJobs(event);
      if (
        event.type === "run.completed" ||
        event.type === "run.failed" ||
        event.type === "run.canceled"
      ) {
        void canvasPersistenceRef.current?.reconcile("run_terminal");
      }
    },
    [checkForTimedOutJobs],
  );

  const [ownedRunController, setOwnedRunController] = useState<{
    canvasId: string;
    controller: AgentRunController;
  } | null>(null);

  useEffect(() => {
    const ownedCanvasId = canvasData?.id;
    if (!ownedCanvasId) return;
    const controller = createAgentRunController({
      canvasId: ownedCanvasId,
      ws: {
        onEvent: ws.onEvent,
        resumeCanvas: ws.resumeCanvas,
      },
      onCanvasSync: (event) => void handleCanvasSync(event),
      onRunEvent: handleStreamEvent,
      onPersistenceFailure: async (run) => {
        const token = accessTokenRef.current;
        if (!token) {
          console.warn("[agent-run] fallback_persistence_skipped", {
            canvasId: ownedCanvasId,
            runId: run.runId,
            reason: "missing_access_token",
          });
          return;
        }
        const content = run.contentBlocks
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("");
        await saveMessage(token, run.sessionId, {
          id: run.runId,
          role: "assistant",
          content,
          contentBlocks: run.contentBlocks,
        }).catch((error) => {
          console.warn("[agent-run] fallback_persistence_failed", {
            canvasId: ownedCanvasId,
            runId: run.runId,
            sessionId: run.sessionId,
            errorCode: "assistant_fallback_persistence_failed",
            error: error instanceof Error ? error.message : "unknown_error",
          });
        });
      },
      onRecoveredPersistenceFailure: async (event) => {
        const token = accessTokenRef.current;
        if (!token || !event.assistant || !event.sessionId) return;
        await saveMessage(token, event.sessionId, {
          id: event.runId,
          role: "assistant",
          content: event.assistant.content,
          contentBlocks: event.assistant.contentBlocks,
        }).catch((error) => {
          console.warn("[agent-run] recovered_persistence_failed", {
            canvasId: ownedCanvasId,
            runId: event.runId,
            sessionId: event.sessionId,
            error: error instanceof Error ? error.message : "unknown_error",
          });
        });
      },
      onReplayGap: ({ canvasId: replayCanvasId, sessionId }) => {
        console.warn("[agent-run] replay_gap", {
          canvasId: replayCanvasId,
          ...(sessionId ? { sessionId } : {}),
        });
        const owner = chatOwnerRef.current;
        if (!owner.userId || !owner.workspaceId) return;
        const queryKey = sessionId
          ? queryKeys.workspace.chatMessages(
              owner.userId,
              owner.workspaceId,
              replayCanvasId,
              sessionId,
            )
          : queryKeys.workspace.canvas(
              owner.userId,
              owner.workspaceId,
              replayCanvasId,
            );
        void queryClient
          .invalidateQueries({
            queryKey,
            refetchType: "all",
          })
          .catch((error) => {
            console.warn("[agent-run] replay_gap_reload_failed", {
              canvasId: replayCanvasId,
              ...(sessionId ? { sessionId } : {}),
              error: error instanceof Error ? error.message : "unknown_error",
            });
          });
      },
      onDiagnostic: (diagnostic) => {
        console.info("[agent-run] controller", diagnostic);
      },
    });
    setOwnedRunController({ canvasId: ownedCanvasId, controller });
    return () => controller.dispose();
  }, [
    canvasData?.id,
    handleCanvasSync,
    handleStreamEvent,
    queryClient,
    ws.onEvent,
    ws.resumeCanvas,
  ]);

  const runController =
    ownedRunController && ownedRunController.canvasId === canvasData?.id
      ? ownedRunController.controller
      : null;

  // Resume belongs to the canvas owner so reconnect recovery continues even
  // while the chat panel is not mounted.
  useEffect(() => {
    if (!ws.connected || !runController) return;
    runController.requestResume();
  }, [runController, ws.connected]);

  if (!canvasId) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-muted-foreground">No canvas ID specified.</p>
      </div>
    );
  }

  if (authLoading || pageLoading) {
    return <LoadingScreen />;
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-destructive">{error}</p>
      </div>
    );
  }

  if (!canvasData || !accessToken || !userId) return null;
  if (!runController) return <LoadingScreen />;

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      {/* Top-left navigation bar */}
      <div className="absolute top-3 left-3 z-20 flex items-center gap-1.5">
        <CanvasLogoMenu
          accessToken={accessToken}
          projectId={canvasData.projectId}
          canvasId={canvasData.id}
          excalidrawApi={excalidrawApi}
        />
        <EditableProjectName
          accessToken={accessToken}
          projectId={canvasData.projectId}
          initialName={projectName}
        />
        <BrandKitSelector
          accessToken={accessToken}
          projectId={canvasData.projectId}
          currentBrandKitId={brandKitId}
          onBrandKitChange={(kitId) => setBrandKitId(kitId)}
        />
      </div>
      {/* Canvas always takes full width; on mobile/tablet, ChatSidebar overlays instead of side-by-side */}
      <div className="flex-1 relative min-w-0 overflow-hidden">
        {/* Credits button — canvas area top-right, NOT chatbar */}
        <div className="absolute top-3 right-3 z-20">
          <CreditHeaderButton />
        </div>
        <CanvasEditor
          canvasId={canvasData.id}
          projectId={canvasData.projectId}
          accessToken={accessToken}
          userId={userId}
          initialRevision={canvasData.revision}
          initialContent={canvasData.content}
          onApiReady={handleApiReady}
          onPersistenceReady={handlePersistenceReady}
          ws={ws}
          leftPanelOpen={layersOpen || filesOpen}
          onSelectionChange={setSelectedCanvasElements}
        />
        <CanvasEmptyHint
          excalidrawApi={excalidrawApi}
          onOpenChat={handleOpenChat}
        />
        <CanvasBottomBar
          excalidrawApi={excalidrawApi}
          layersOpen={layersOpen}
          onToggleLayers={handleToggleLayers}
          filesOpen={filesOpen}
          onToggleFiles={handleToggleFiles}
          leftPanelOpen={layersOpen || filesOpen}
        />
        <CanvasLayersPanel
          excalidrawApi={excalidrawApi}
          open={layersOpen}
          onClose={handleCloseLayers}
        />
        <CanvasFilesPanel
          excalidrawApi={excalidrawApi}
          open={filesOpen}
          onClose={handleCloseFiles}
        />
      </div>
      {chatOpen ? (
        <ChatSidebar
          accessToken={accessToken}
          canvasId={canvasData.id}
          open
          onToggle={handleToggleChat}
          onCanvasSync={handleCanvasSync}
          onStreamEvent={handleStreamEvent}
          initialPrompt={initialPrompt}
          initialSessionId={initialSessionId}
          onSessionChange={handleSessionChange}
          onRequestCanvasImages={handleRequestCanvasImages}
          currentBrandKitId={brandKitId}
          ws={ws}
          runController={runController}
          selectedCanvasElements={selectedCanvasElements}
        />
      ) : (
        <div className="absolute right-3 top-3 z-20">
          <button
            aria-label="打开对话"
            className="inline-flex size-9 items-center justify-center rounded-md border border-border bg-card/90 text-foreground/70 shadow-sm backdrop-blur-sm transition-colors hover:bg-card hover:text-foreground"
            onClick={handleOpenChat}
            title="打开对话"
            type="button"
          >
            <MessageCircle aria-hidden="true" className="size-4" />
          </button>
        </div>
      )}
    </div>
  );
}

export default function CanvasPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <CanvasPageContent />
    </Suspense>
  );
}
