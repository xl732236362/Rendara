"use client";

import { RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type {
  ContentBlock,
  ImageArtifact,
  ImageGenerationPreference,
  MessageMention,
  StreamEvent,
  ToolBlock,
  VideoArtifact,
  VideoGenerationPreference,
} from "@loomic/shared";
import { useAgentModel } from "../hooks/use-agent-model";
import { useBreakpoint } from "../hooks/use-breakpoint";
import { mapServerMessages, useChatSessions } from "../hooks/use-chat-sessions";
import { useChatStream } from "../hooks/use-chat-stream";
import {
  INITIAL_AGENT_MODEL_KEY,
  INITIAL_ATTACHMENTS_KEY,
  INITIAL_IMAGE_GENERATION_PREFERENCE_KEY,
} from "../hooks/use-create-project";
import type { ReadyAttachment } from "../hooks/use-image-attachments";
import { useImageAttachments } from "../hooks/use-image-attachments";
import { useImageModelPreference } from "../hooks/use-image-model-preference";
import { useVideoModelPreference } from "../hooks/use-video-model-preference";
import type { RunCallbacks, WebSocketHandle } from "../hooks/use-websocket";
import { useAuth } from "../lib/auth-context";
import { fetchBrandKit } from "../lib/brand-kit-api";
import { claimDailyCredits } from "../lib/credits-api";
import {
  useImageModelsQuery,
  useViewerQuery,
} from "../lib/query/workspace-queries";
import {
  fetchGeneratedAssetAttachment,
  fetchOutstandingGeneratedAssetAttachments,
  retryGeneratedAssetAttachment,
  saveMessage,
} from "../lib/server-api";
import type { CanvasSelectedElement } from "./canvas-editor";
import {
  type BrandKitMentionItem,
  type CanvasImageItem,
  type ImageModelMentionItem,
  MessageMentionPicker,
  type MessageMentionPickerItem,
} from "./canvas-image-picker";
import { ChatInput } from "./chat-input";
import { ChatMessage } from "./chat-message";
import { ChatSkills } from "./chat-skills";
import { CreditInsufficientDialog } from "./credits/credit-insufficient-dialog";
import { useTierLimitToast } from "./credits/tier-limit-toast";
import { ErrorBoundary } from "./error-boundary";
import { SessionSelector } from "./session-selector";
import { useToast } from "./toast";

type ChatSidebarProps = {
  accessToken: string;
  canvasId: string;
  open: boolean;
  onToggle: () => void;
  onImageGenerated?: (artifact: ImageArtifact) => void;
  onVideoGenerated?: (artifact: VideoArtifact) => void;
  onCanvasSync?: (event: Extract<StreamEvent, { type: "canvas.sync" }>) => void;
  /** Called for every stream event — used by job fallback polling to detect timed-out jobs */
  onStreamEvent?: (event: StreamEvent) => void;
  initialPrompt?: string | undefined;
  initialSessionId?: string | undefined;
  onSessionChange?: (sessionId: string) => void;
  onRequestCanvasImages?: () => CanvasImageItem[];
  currentBrandKitId?: string | null;
  ws: WebSocketHandle;
  selectedCanvasElements?: CanvasSelectedElement[];
};

function acceptanceFailureText(
  code: string | undefined,
  requestId: string,
): string {
  switch (code) {
    case "agent_context_timeout":
      return "Agent 上下文加载超时，请重试。";
    case "agent_context_unavailable":
    case "agent_acceptance_unavailable":
      return "Agent 服务暂时不可用，请稍后重试。";
    case "agent_acceptance_indeterminate":
      return "请求仍在确认中，请使用原请求重试。";
    case "agent_acceptance_conflict":
      return "该请求与之前的提交不一致，请重新发送。";
    case "agent_context_forbidden":
      return "当前会话或画布无权运行 Agent。";
    case "agent_acceptance_failed":
      return "Agent 请求未能接受，请重新发送。";
    default:
      return `Agent 暂时无法响应，请求编号：${requestId}`;
  }
}

export function ChatSidebar({
  accessToken,
  canvasId,
  open,
  onToggle,
  onCanvasSync,
  onStreamEvent,
  initialPrompt,
  initialSessionId,
  onSessionChange,
  onRequestCanvasImages,
  currentBrandKitId,
  ws,
  selectedCanvasElements,
}: ChatSidebarProps) {
  const breakpoint = useBreakpoint();
  const isOverlay = breakpoint !== "desktop";
  const { user } = useAuth();
  const catalogTokenRef = useRef(accessToken);
  catalogTokenRef.current = accessToken;
  const getCatalogToken = useCallback(() => catalogTokenRef.current, []);
  const viewer = useViewerQuery(user?.id, getCatalogToken);
  const imageModelsQuery = useImageModelsQuery(
    user
      ? {
          userId: user.id,
          workspaceId: viewer.data?.workspace.id,
          getAccessToken: getCatalogToken,
        }
      : undefined,
  );

  // ── Session and durable message-page management ──
  const {
    sessions,
    activeSessionId,
    activeSessionIdRef,
    messages,
    messagesRef,
    setMessages,
    sessionsLoading,
    messagesLoading,
    hasOlderSessions,
    loadingOlderSessions,
    loadOlderSessions,
    hasOlderMessages,
    loadingOlderMessages,
    loadOlderMessages,
    streaming,
    setStreaming,
    updateSessionMessages,
    getSessionMessages,
    handleSelectSession,
    handleNewChat,
    handleDeleteSession,
    autoTitleSession,
    reloadMessages,
    accessTokenRef,
  } = useChatSessions({
    canvasId,
    accessToken,
    initialSessionId,
    onSessionChange,
  });

  // ── Stream event handler (extracted hook, shared between send & reconnect) ──
  const { applyStreamEvent } = useChatStream(updateSessionMessages);

  // ── Mention & attachment state ──
  const [atQuery, setAtQuery] = useState<string | null>(null);
  const [messageMentions, setMessageMentions] = useState<MessageMention[]>([]);
  const [brandKitMentionItems, setBrandKitMentionItems] = useState<
    BrandKitMentionItem[]
  >([]);
  const [imageModelMentionItems, setImageModelMentionItems] = useState<
    ImageModelMentionItem[]
  >([]);
  const [creditDialog, setCreditDialog] = useState<{
    open: boolean;
    currentBalance: number;
    requiredAmount: number;
    plan: string;
    dailyClaimed: boolean;
  } | null>(null);
  const [pendingAcceptanceRetry, setPendingAcceptanceRetry] = useState<{
    assistantId: string;
    retry: () => void;
  } | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const chatInputRef = useRef<import("./chat-input").ChatInputHandle>(null);

  const initialPromptSent = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesViewportRef = useRef<HTMLDivElement>(null);
  const preservingOlderAnchorRef = useRef(false);
  const abortRef = useRef(false);
  const messageMentionsRef = useRef(messageMentions);
  messageMentionsRef.current = messageMentions;
  const selectedCanvasElementsRef = useRef(selectedCanvasElements);
  selectedCanvasElementsRef.current = selectedCanvasElements;
  const prevConnectedRef = useRef(false);
  const fallbackPersistedRunIdsRef = useRef(new Set<string>());
  const assistantIdByRunIdRef = useRef(new Map<string, string>());
  const runListenerByRunIdRef = useRef(
    new Map<
      string,
      { assistantId: string; cleanup: () => void; resolve?: () => void }
    >(),
  );

  // A remounted sidebar owns fresh listeners. Release any listeners from this
  // instance so resume can safely recover the active run without duplicates.
  useEffect(() => {
    return () => {
      for (const listener of runListenerByRunIdRef.current.values()) {
        listener.cleanup();
      }
      runListenerByRunIdRef.current.clear();
    };
  }, []);

  const {
    attachments: imageAttachments,
    addFiles,
    addCanvasRef,
    retryUpload,
    removeAttachment,
    clearAll: clearAttachments,
    isUploading,
    readyAttachments,
  } = useImageAttachments(accessToken);

  const { activeImageGenerationPreference } = useImageModelPreference();
  const activeImageGenerationPreferenceRef = useRef(
    activeImageGenerationPreference,
  );
  activeImageGenerationPreferenceRef.current = activeImageGenerationPreference;

  const { activeVideoGenerationPreference } = useVideoModelPreference();
  const activeVideoGenerationPreferenceRef = useRef(
    activeVideoGenerationPreference,
  );
  activeVideoGenerationPreferenceRef.current = activeVideoGenerationPreference;

  const { model: agentModel } = useAgentModel();
  const agentModelRef = useRef(agentModel);
  agentModelRef.current = agentModel;

  const { showTierLimit } = useTierLimitToast();
  const { toast: showToast } = useToast();

  const persistAssistantFallback = useCallback(
    (sessionId: string, runId: string) => {
      if (fallbackPersistedRunIdsRef.current.has(runId)) return;
      const assistantId = assistantIdByRunIdRef.current.get(runId);
      if (!assistantId) return;
      const assistant = getSessionMessages(sessionId).find(
        (message) => message.id === assistantId && message.role === "assistant",
      );
      if (!assistant) return;
      fallbackPersistedRunIdsRef.current.add(runId);
      const content = assistant.contentBlocks
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      void saveMessage(accessTokenRef.current, sessionId, {
        id: runId,
        role: "assistant",
        content,
        contentBlocks: assistant.contentBlocks,
      }).catch(() => {
        fallbackPersistedRunIdsRef.current.delete(runId);
        console.warn("[chat] assistant fallback persistence failed", {
          assistantId,
          errorCode: "assistant_fallback_persistence_failed",
          runId,
          sessionId,
        });
      });
    },
    [accessTokenRef, getSessionMessages],
  );

  const persistRecoveredAssistantFallback = useCallback(
    (
      sessionId: string,
      runId: string,
      assistant: { content: string; contentBlocks: ContentBlock[] },
    ) => {
      if (fallbackPersistedRunIdsRef.current.has(runId)) return;
      fallbackPersistedRunIdsRef.current.add(runId);
      void saveMessage(accessTokenRef.current, sessionId, {
        id: runId,
        role: "assistant",
        content: assistant.content,
        contentBlocks: assistant.contentBlocks,
      }).catch(() => {
        fallbackPersistedRunIdsRef.current.delete(runId);
        console.warn("[chat] remounted assistant fallback persistence failed", {
          errorCode: "assistant_remounted_fallback_persistence_failed",
          runId,
          sessionId,
        });
      });
    },
    [accessTokenRef],
  );

  const syncedAttachmentRevisionsRef = useRef(new Map<string, number>());
  const attachedJobIdsRef = useRef(new Set<string>());

  const syncAttachedStatuses = useCallback(
    (
      statuses: Awaited<
        ReturnType<typeof fetchOutstandingGeneratedAssetAttachments>
      >["attachments"],
    ) => {
      for (const status of statuses) {
        if (status.attachmentStatus !== "attached") continue;
        if (
          syncedAttachmentRevisionsRef.current.get(status.jobId) ===
          status.canvasRevision
        ) {
          continue;
        }
        syncedAttachmentRevisionsRef.current.set(
          status.jobId,
          status.canvasRevision,
        );
        onCanvasSync?.({
          type: "canvas.sync",
          eventId: `attachment-${status.jobId}`,
          canvasId,
          revision: status.canvasRevision,
          timestamp: new Date().toISOString(),
        });
      }
    },
    [canvasId, onCanvasSync],
  );

  const applyAttachmentStatuses = useCallback(
    (
      sessionId: string,
      statuses: Awaited<
        ReturnType<typeof fetchOutstandingGeneratedAssetAttachments>
      >["attachments"],
    ) => {
      for (const status of statuses) {
        if (status.attachmentStatus === "attached") {
          attachedJobIdsRef.current.add(status.jobId);
        }
      }
      const applicableStatuses = statuses.filter(
        (status) =>
          status.attachmentStatus === "attached" ||
          !attachedJobIdsRef.current.has(status.jobId),
      );
      const byJob = new Map(
        applicableStatuses.map((status) => [status.jobId, status]),
      );
      updateSessionMessages(sessionId, (prev) => {
        const knownJobs = new Set<string>();
        const updated = prev.map((message) => ({
          ...message,
          contentBlocks: message.contentBlocks.map((block) => {
            if (block.type !== "tool" || !block.recovery) return block;
            knownJobs.add(block.recovery.jobId);
            const status = byJob.get(block.recovery.jobId);
            if (!status) return block;
            if (status.attachmentStatus === "attached") {
              return {
                ...block,
                status: "completed" as const,
                outputSummary: "Attached to canvas",
                output: {
                  elementId: status.elementId,
                  canvasRevision: status.canvasRevision,
                },
                error: undefined,
                recovery: undefined,
              };
            }
            if (
              status.attachmentStatus === "pending" ||
              status.attachmentStatus === "not_attached"
            ) {
              return {
                ...block,
                status: "failed" as const,
                outputSummary: status.error.message,
                error: block.error ?? {
                  code: status.error.code,
                  message: status.error.message,
                  correlationId: status.jobId,
                },
                recovery: status.recovery,
              };
            }
            return block;
          }),
        }));
        for (const status of applicableStatuses) {
          if (
            knownJobs.has(status.jobId) ||
            (status.attachmentStatus !== "pending" &&
              status.attachmentStatus !== "not_attached")
          ) {
            continue;
          }
          updated.push({
            id: `attachment-recovery-${status.jobId}`,
            role: "assistant",
            contentBlocks: [
              {
                type: "tool",
                toolCallId: `attachment-recovery-${status.jobId}`,
                toolName: "generated_asset_attachment",
                status: "failed",
                outputSummary: status.error.message,
                error: {
                  code: status.error.code,
                  message: status.error.message,
                  correlationId: status.jobId,
                },
                recovery: status.recovery,
              },
            ],
          });
        }
        return updated;
      });
    },
    [updateSessionMessages],
  );

  const refreshAttachmentRecovery = useCallback(
    async (sessionId: string) => {
      try {
        const recoveryBlocks = getSessionMessages(sessionId).flatMap(
          (message) =>
            message.contentBlocks.filter(
              (block): block is ToolBlock =>
                block.type === "tool" && !!block.recovery,
            ),
        );
        const jobIds = [
          ...new Set(recoveryBlocks.map((block) => block.recovery?.jobId)),
        ].filter((jobId): jobId is string => !!jobId);
        const [outstanding, ...known] = await Promise.all([
          fetchOutstandingGeneratedAssetAttachments(
            accessTokenRef.current,
            canvasId,
            sessionId,
          ),
          ...jobIds.map((jobId) =>
            fetchGeneratedAssetAttachment(
              accessTokenRef.current,
              canvasId,
              jobId,
            ).then((result) => result.attachment),
          ),
        ]);
        const statuses = [...outstanding.attachments, ...known];
        applyAttachmentStatuses(sessionId, statuses);
        syncAttachedStatuses(statuses);
      } catch (error) {
        console.warn("[chat] attachment recovery refresh failed", {
          canvasId,
          sessionId,
          errorCode: "attachment_recovery_refresh_failed",
        });
      }
    },
    [
      accessTokenRef,
      applyAttachmentStatuses,
      canvasId,
      getSessionMessages,
      syncAttachedStatuses,
    ],
  );

  const handleRetryAttachment = useCallback(
    async (block: ToolBlock) => {
      if (block.recovery?.kind !== "attach_generated_asset") return;
      const result = await retryGeneratedAssetAttachment(
        accessTokenRef.current,
        canvasId,
        block.recovery.jobId,
      );
      const sessionId = activeSessionIdRef.current;
      if (sessionId) applyAttachmentStatuses(sessionId, [result.attachment]);
      syncAttachedStatuses([result.attachment]);
    },
    [
      accessTokenRef,
      activeSessionIdRef,
      applyAttachmentStatuses,
      canvasId,
      syncAttachedStatuses,
    ],
  );

  const attachmentRecoveryKey = messages
    .flatMap((message) => message.contentBlocks)
    .filter(
      (block): block is ToolBlock =>
        block.type === "tool" &&
        block.status === "failed" &&
        block.recovery?.kind === "attach_generated_asset",
    )
    .map((block) => block.recovery?.jobId)
    .filter(Boolean)
    .sort()
    .join(",");

  useEffect(() => {
    if (sessionsLoading || messagesLoading || !activeSessionId) return;
    void refreshAttachmentRecovery(activeSessionId);
  }, [
    activeSessionId,
    attachmentRecoveryKey,
    messagesLoading,
    refreshAttachmentRecovery,
    sessionsLoading,
  ]);

  // ── Sidebar resize ──
  const SIDEBAR_MIN = 300;
  const SIDEBAR_MAX = 600;
  const SIDEBAR_KEYBOARD_STEP = 20;
  const [sidebarWidth, setSidebarWidth] = useState(400);
  const isResizing = useRef(false);

  const clampWidth = useCallback(
    (w: number) => Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w)),
    [],
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isResizing.current = true;
      const startX = e.clientX;
      const startWidth = sidebarWidth;

      const handleMouseMove = (moveEvent: MouseEvent) => {
        if (!isResizing.current) return;
        const delta = startX - moveEvent.clientX;
        setSidebarWidth(clampWidth(startWidth + delta));
      };

      const handleMouseUp = () => {
        isResizing.current = false;
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [sidebarWidth, clampWidth],
  );

  // Touch support for resize handle (mobile / tablet)
  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      const touch = e.touches[0];
      if (!touch) return;
      isResizing.current = true;
      const startX = touch.clientX;
      const startWidth = sidebarWidth;

      const handleTouchMove = (moveEvent: TouchEvent) => {
        if (!isResizing.current) return;
        const t = moveEvent.touches[0];
        if (!t) return;
        moveEvent.preventDefault(); // prevent scroll during resize
        const delta = startX - t.clientX;
        setSidebarWidth(clampWidth(startWidth + delta));
      };

      const handleTouchEnd = () => {
        isResizing.current = false;
        document.removeEventListener("touchmove", handleTouchMove);
        document.removeEventListener("touchend", handleTouchEnd);
        document.removeEventListener("touchcancel", handleTouchEnd);
      };

      document.addEventListener("touchmove", handleTouchMove, {
        passive: false,
      });
      document.addEventListener("touchend", handleTouchEnd);
      document.addEventListener("touchcancel", handleTouchEnd);
    },
    [sidebarWidth, clampWidth],
  );

  // Keyboard support for resize handle (ArrowLeft/ArrowRight)
  const handleResizeKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setSidebarWidth((prev) => clampWidth(prev + SIDEBAR_KEYBOARD_STEP));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setSidebarWidth((prev) => clampWidth(prev - SIDEBAR_KEYBOARD_STEP));
      }
    },
    [clampWidth],
  );

  // ── Auto-scroll to bottom ──
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    if (preservingOlderAnchorRef.current) return;
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const handleLoadOlderMessages = useCallback(async () => {
    const viewport = messagesViewportRef.current;
    if (!viewport) return;
    const previousHeight = viewport.scrollHeight;
    const previousTop = viewport.scrollTop;
    preservingOlderAnchorRef.current = true;
    try {
      await loadOlderMessages();
      requestAnimationFrame(() => {
        viewport.scrollTop =
          previousTop + (viewport.scrollHeight - previousHeight);
        preservingOlderAnchorRef.current = false;
      });
    } catch {
      preservingOlderAnchorRef.current = false;
    }
  }, [loadOlderMessages]);

  // ── Fetch image models for @mention picker ──
  useEffect(() => {
    setImageModelMentionItems(
      (imageModelsQuery.data?.models ?? []).map((model) => ({
        kind: "image-model",
        id: model.id,
        label: model.displayName,
        description: model.description,
        ...(model.iconUrl ? { iconUrl: model.iconUrl } : {}),
      })),
    );
  }, [imageModelsQuery.data?.models]);

  // ── Fetch brand kit items for @mention picker ──
  useEffect(() => {
    if (!currentBrandKitId) {
      setBrandKitMentionItems([]);
      return;
    }

    let cancelled = false;
    fetchBrandKit(accessTokenRef.current, currentBrandKitId)
      .then((kit) => {
        if (cancelled) return;
        setBrandKitMentionItems(
          kit.assets.map((asset) => ({
            kind: "brand-kit-asset" as const,
            id: asset.id,
            label: asset.display_name,
            assetType: asset.asset_type,
            textContent: asset.text_content,
            fileUrl: asset.file_url,
            thumbnailUrl:
              asset.asset_type === "logo" || asset.asset_type === "image"
                ? asset.file_url
                : null,
          })),
        );
      })
      .catch(() => {
        if (!cancelled) setBrandKitMentionItems([]);
      });

    return () => {
      cancelled = true;
    };
  }, [currentBrandKitId, accessTokenRef]);

  // ── Send message ──
  const handleSend = useCallback(
    async (
      text: string,
      attachmentsOverride?: ReadyAttachment[],
      imageGenerationPreferenceOverride?: ImageGenerationPreference,
      mentionsOverride?: MessageMention[],
    ) => {
      const currentSessionId = activeSessionIdRef.current;
      if (streaming || !currentSessionId) return;

      // Merge explicitly-attached images with auto-sensed canvas selection images
      let currentAttachments = attachmentsOverride ?? readyAttachments;
      const selectedEls = selectedCanvasElementsRef.current ?? [];
      const selectedImageEls = selectedEls.filter(
        (el) =>
          el.type === "image" && el.fileId && (el.storageUrl || el.dataUrl),
      );
      if (selectedImageEls.length > 0 && !attachmentsOverride) {
        const existingIds = new Set(currentAttachments.map((a) => a.assetId));
        const selectionAttachments: ReadyAttachment[] = selectedImageEls
          .filter((el) => !existingIds.has(el.id))
          .map((el) => ({
            assetId: el.id,
            url: el.storageUrl ?? el.dataUrl!,
            mimeType: "image/png",
            source: "canvas-ref" as const,
            name: `Canvas selection ${el.id.slice(0, 6)}`,
          }));
        if (selectionAttachments.length > 0) {
          currentAttachments = [...currentAttachments, ...selectionAttachments];
        }
      }
      const currentImageGenerationPreference =
        imageGenerationPreferenceOverride ??
        activeImageGenerationPreferenceRef.current;
      const currentVideoGenerationPreference =
        activeVideoGenerationPreferenceRef.current;
      const currentMentions = mentionsOverride ?? messageMentionsRef.current;

      // Add user message locally
      const imageBlocks: ContentBlock[] = currentAttachments.map((a) => ({
        type: "image" as const,
        assetId: a.assetId,
        url: a.url,
        mimeType: a.mimeType,
        source: a.source,
        ...(a.name ? { name: a.name } : {}),
      }));
      const mentionBlocks: ContentBlock[] = currentMentions.map((mention) => {
        if (mention.mentionType === "image-model") {
          return {
            type: "mention" as const,
            mentionType: "image-model" as const,
            id: mention.id,
            label: mention.label,
          };
        }
        return {
          type: "mention" as const,
          mentionType: "brand-kit-asset" as const,
          id: mention.id,
          label: mention.label,
          assetType: mention.assetType,
          ...(mention.textContent !== undefined
            ? { textContent: mention.textContent }
            : {}),
          ...(mention.fileUrl !== undefined
            ? { fileUrl: mention.fileUrl }
            : {}),
        };
      });
      const userMessageId = crypto.randomUUID();
      const userMsg = {
        id: userMessageId,
        role: "user" as const,
        contentBlocks: [
          { type: "text" as const, text },
          ...mentionBlocks,
          ...imageBlocks,
        ],
      };
      updateSessionMessages(currentSessionId, (prev) => [...prev, userMsg]);

      // Persist user message (fire-and-forget)
      saveMessage(accessTokenRef.current, currentSessionId, {
        id: userMessageId,
        role: "user",
        content: text,
        contentBlocks: [
          { type: "text" as const, text },
          ...mentionBlocks,
          ...imageBlocks,
        ],
      }).catch((err) =>
        console.error("[chat] Failed to save user message:", err),
      );

      // Auto-title from first user message
      autoTitleSession(text);

      // Create assistant placeholder
      const assistantId = `assistant-${Date.now()}`;
      updateSessionMessages(currentSessionId, (prev) => [
        ...prev,
        { id: assistantId, role: "assistant" as const, contentBlocks: [] },
      ]);
      setStreaming(true);
      abortRef.current = false;

      const normalizedRequest = {
        sessionId: currentSessionId,
        conversationId: canvasId,
        prompt: text,
        canvasId,
        clientRequestId: crypto.randomUUID(),
        ...(currentAttachments.length > 0
          ? { attachments: currentAttachments }
          : {}),
        ...(currentMentions.length > 0 ? { mentions: currentMentions } : {}),
        ...(currentImageGenerationPreference
          ? { imageGenerationPreference: currentImageGenerationPreference }
          : {}),
        ...(currentVideoGenerationPreference
          ? { videoGenerationPreference: currentVideoGenerationPreference }
          : {}),
        ...(agentModelRef.current ? { model: agentModelRef.current } : {}),
      };

      try {
        const perf = {
          t0Send: performance.now(),
          tAck: 0,
          tFirstToken: 0,
          gotFirstToken: false,
        };

        let resolveStream: () => void;
        const streamDone = new Promise<void>((r) => {
          resolveStream = r;
        });
        const runIdRef = { current: "" };

        let cleanup = () => {};
        const cleanupRunListener = () => {
          cleanup();
          const runId = runIdRef.current;
          if (
            runId &&
            runListenerByRunIdRef.current.get(runId)?.cleanup ===
              cleanupRunListener
          ) {
            runListenerByRunIdRef.current.delete(runId);
          }
        };
        cleanup = ws.onEvent((event) => {
          if (event.type === "canvas.sync") {
            if (event.canvasId === canvasId) onCanvasSync?.(event);
            return;
          }
          if (!runIdRef.current || event.runId !== runIdRef.current) return;
          if (abortRef.current) {
            resolveStream();
            return;
          }

          // Track first token timing
          if (!perf.gotFirstToken && event.type === "message.delta") {
            perf.tFirstToken = performance.now();
            perf.gotFirstToken = true;
            console.log(
              `[perf] send → first token: ${(perf.tFirstToken - perf.t0Send).toFixed(0)}ms` +
                ` (ack→token: ${(perf.tFirstToken - perf.tAck).toFixed(0)}ms)`,
            );
          }

          // Billing error: route to appropriate UI, run.canceled will follow
          if (event.type === "billing.error") {
            if (event.code === "insufficient_credits") {
              setCreditDialog({
                open: true,
                currentBalance: event.currentBalance ?? 0,
                requiredAmount: event.requiredAmount ?? 0,
                plan: event.plan ?? "free",
                dailyClaimed: event.dailyClaimed ?? false,
              });
            } else {
              // model_not_accessible, resolution_not_allowed, concurrency_limit
              showTierLimit({ code: event.code, message: event.message });
            }
          }

          // Apply event to messages (single source of truth — shared with reconnect)
          applyStreamEvent(event, assistantId, currentSessionId);

          // Forward event to parent for fallback job polling (timed-out generation recovery)
          onStreamEvent?.(event);

          if (event.type === "assistant.persistence_failed") {
            persistAssistantFallback(currentSessionId, event.runId);
          }

          // Preview model hint: suggest switching when run fails
          if (event.type === "run.failed") {
            const currentModel = agentModelRef.current ?? "";
            if (currentModel.includes("preview")) {
              showToast(
                "当前 Preview 模型请求不稳定，建议切换模型后重试",
                "error",
              );
            }
          }

          if (
            event.type === "run.completed" ||
            event.type === "run.failed" ||
            event.type === "run.canceled"
          ) {
            void refreshAttachmentRecovery(currentSessionId);
            resolveStream();
          }
        });

        // Start run via WebSocket
        const runId = await new Promise<string>((resolve, reject) => {
          const timeout = setTimeout(() => {
            cleanupRunListener();
            reject(new Error("WebSocket ack timeout — connection may be down"));
          }, 15_000);

          const transportRequest = {
            ...normalizedRequest,
            accessToken: accessTokenRef.current,
          };
          let retrySubmission: () => void;
          const callbacks: RunCallbacks = {
            onAck: (ack) => {
              clearTimeout(timeout);
              setPendingAcceptanceRetry(null);
              perf.tAck = performance.now();
              console.log(
                `[perf] send → ack: ${(perf.tAck - perf.t0Send).toFixed(0)}ms`,
              );
              const id = ack.payload.runId as string;
              runIdRef.current = id;
              assistantIdByRunIdRef.current.set(id, assistantId);
              runListenerByRunIdRef.current.set(id, {
                assistantId,
                cleanup: cleanupRunListener,
                resolve: resolveStream,
              });
              setActiveRunId(id);
              resolve(id);
            },
            onError: (error) => {
              clearTimeout(timeout);
              if (error.retryable) {
                setPendingAcceptanceRetry({
                  assistantId,
                  retry: retrySubmission,
                });
              }
              reject(
                Object.assign(new Error(error.error.message), {
                  wsError: error,
                }),
              );
            },
          };
          retrySubmission = () => {
            setPendingAcceptanceRetry(null);
            setStreaming(true);
            const sent = ws.startRun(
              {
                ...normalizedRequest,
                accessToken: accessTokenRef.current,
              },
              callbacks,
            );
            if (!sent) {
              callbacks.onError({
                type: "error",
                action: "agent.run",
                clientRequestId: normalizedRequest.clientRequestId,
                retryable: true,
                error: {
                  code: "agent_acceptance_unavailable",
                  message: "连接尚未恢复。",
                },
              });
              setStreaming(false);
              return;
            }
            void streamDone.finally(() => {
              cleanupRunListener();
              setStreaming(false);
            });
          };
          ws.startRun(transportRequest, callbacks);
        });
        clearAttachments();
        setMessageMentions([]);

        await streamDone;
        cleanupRunListener();
      } catch (error) {
        const wsError = (error as { wsError?: { error?: { code?: string } } })
          .wsError;
        const failureText = acceptanceFailureText(
          wsError?.error?.code,
          normalizedRequest.clientRequestId,
        );
        updateSessionMessages(currentSessionId, (prev) =>
          prev.map((m) => {
            if (m.id !== assistantId) return m;
            const hasText = m.contentBlocks.some((b) => b.type === "text");
            if (hasText) return m;
            return {
              ...m,
              contentBlocks: [
                ...m.contentBlocks,
                { type: "text" as const, text: failureText },
              ],
            };
          }),
        );
      } finally {
        setActiveRunId(null);
        setStreaming(false);
      }
    },
    [
      streaming,
      canvasId,
      applyStreamEvent,
      updateSessionMessages,
      onCanvasSync,
      onStreamEvent,
      readyAttachments,
      clearAttachments,
      ws,
      autoTitleSession,
      accessTokenRef,
      activeSessionIdRef,
      refreshAttachmentRecovery,
      persistAssistantFallback,
    ],
  );

  // ── Mention picker ──
  const mentionPickerItems: MessageMentionPickerItem[] = [
    ...(onRequestCanvasImages ? onRequestCanvasImages() : []),
    ...brandKitMentionItems,
    ...imageModelMentionItems,
  ];

  const handleMentionSelect = useCallback(
    (item: MessageMentionPickerItem) => {
      if (item.kind === "canvas-image") {
        addCanvasRef({
          assetId: item.assetId,
          url: item.url,
          mimeType: item.mimeType,
          name: item.name,
        });
        return;
      }

      setMessageMentions((prev) => {
        let nextMention: MessageMention;
        if (item.kind === "image-model") {
          nextMention = {
            mentionType: "image-model",
            id: item.id,
            label: item.label,
          };
        } else {
          nextMention = {
            mentionType: "brand-kit-asset",
            id: item.id,
            label: item.label,
            assetType: item.assetType,
            ...(item.textContent !== undefined
              ? { textContent: item.textContent }
              : {}),
            ...(item.fileUrl !== undefined ? { fileUrl: item.fileUrl } : {}),
          };
        }

        if (
          prev.some(
            (m) =>
              m.mentionType === nextMention.mentionType &&
              m.id === nextMention.id,
          )
        ) {
          return prev;
        }
        return [...prev, nextMention];
      });
    },
    [addCanvasRef],
  );

  const handleRemoveMention = useCallback((mention: MessageMention) => {
    setMessageMentions((prev) =>
      prev.filter(
        (item) =>
          !(item.mentionType === mention.mentionType && item.id === mention.id),
      ),
    );
  }, []);

  // ── Auto-send initial prompt ──
  useEffect(() => {
    if (
      !initialPrompt ||
      sessionsLoading ||
      !ws.connected ||
      initialPromptSent.current
    )
      return;

    let storedAttachments: ReadyAttachment[] | undefined;
    let storedImageGenerationPreference: ImageGenerationPreference | undefined;
    let storedAgentModel: string | undefined;
    try {
      const raw = sessionStorage.getItem(INITIAL_ATTACHMENTS_KEY);
      if (raw) {
        storedAttachments = JSON.parse(raw) as ReadyAttachment[];
        sessionStorage.removeItem(INITIAL_ATTACHMENTS_KEY);
      }

      const preferenceRaw = sessionStorage.getItem(
        INITIAL_IMAGE_GENERATION_PREFERENCE_KEY,
      );
      if (preferenceRaw) {
        storedImageGenerationPreference = JSON.parse(
          preferenceRaw,
        ) as ImageGenerationPreference;
        sessionStorage.removeItem(INITIAL_IMAGE_GENERATION_PREFERENCE_KEY);
      }

      const modelRaw = sessionStorage.getItem(INITIAL_AGENT_MODEL_KEY);
      if (modelRaw) {
        storedAgentModel = modelRaw;
        sessionStorage.removeItem(INITIAL_AGENT_MODEL_KEY);
      }
    } catch {
      // Malformed JSON or unavailable storage
    }

    if (storedAgentModel) {
      agentModelRef.current = storedAgentModel;
    }

    const timer = setTimeout(() => {
      if (!activeSessionIdRef.current) return;
      initialPromptSent.current = true;
      void handleSend(
        initialPrompt,
        storedAttachments,
        storedImageGenerationPreference,
      );
    }, 0);

    return () => clearTimeout(timer);
  }, [
    initialPrompt,
    sessionsLoading,
    ws.connected,
    handleSend,
    activeSessionIdRef,
  ]);

  // ── Reconnection: resume canvas binding + reload messages ──
  // Uses the shared applyStreamEvent to handle live events — no duplicated logic.
  useEffect(() => {
    if (!ws.connected || sessionsLoading) {
      if (!ws.connected) prevConnectedRef.current = false;
      return;
    }
    if (prevConnectedRef.current) return;
    prevConnectedRef.current = true;

    const sessionId = activeSessionIdRef.current;
    if (!sessionId) return;

    // Skip if initialPrompt effect will handle binding
    if (initialPrompt && !initialPromptSent.current) return;

    void (async () => {
      // Reload messages from DB (server may have persisted while disconnected)
      await reloadMessages(
        sessionId,
        new Set(assistantIdByRunIdRef.current.values()),
      );

      // Resume canvas binding (after DB messages are set)
      ws.resumeCanvas(canvasId, (ack) => {
        const resumePayload = ack.payload as Record<string, unknown>;
        const activeRunId = resumePayload.activeRunId;
        let resumedRunId = typeof activeRunId === "string" ? activeRunId : null;
        const activeRunSessionId = resumePayload.activeRunSessionId;
        const resumedRunSessionId =
          typeof activeRunSessionId === "string" ? activeRunSessionId : null;
        const replayed = resumePayload.replayed;
        const replayCount =
          typeof replayed === "number" && replayed >= 0 ? replayed : 0;
        const replayGap = resumePayload.replayGap === true;
        const latestRevision = resumePayload.latestRevision;
        const ownsResumedRun =
          resumedRunId !== null && resumedRunSessionId === sessionId;

        if (resumedRunId && !ownsResumedRun) {
          console.info("[chat] ignored active run from another session", {
            activeRunId: resumedRunId,
            activeRunSessionId: resumedRunSessionId,
            sessionId,
          });
          // The active marker may belong to another chat session. It must not
          // prevent this sidebar from consuming replay events for its own runs.
          resumedRunId = null;
        }

        if (replayGap) {
          console.warn("[chat] replay cursor fell behind retained buffer", {
            canvasId,
            sessionId,
          });
          void reloadMessages(
            sessionId,
            new Set(assistantIdByRunIdRef.current.values()),
          );
          if (
            typeof latestRevision === "number" &&
            Number.isSafeInteger(latestRevision) &&
            latestRevision > 0
          ) {
            onCanvasSync?.({
              type: "canvas.sync",
              eventId: `replay-gap-${latestRevision}`,
              canvasId,
              revision: latestRevision,
              timestamp: new Date().toISOString(),
            });
          }
        }

        if (resumedRunId) {
          setStreaming(true);
          setActiveRunId(resumedRunId);

          const activeListener =
            runListenerByRunIdRef.current.get(resumedRunId);
          if (activeListener) {
            // The original send listener is still subscribed. It already owns
            // the placeholder and will receive the resumed stream replay.
            return;
          }

          const assistantId =
            assistantIdByRunIdRef.current.get(resumedRunId) ??
            `resumed_${resumedRunId}`;
          assistantIdByRunIdRef.current.set(resumedRunId, assistantId);
          // Must use updateSessionMessages (not setMessages) so the placeholder
          // lands in msgCacheRef as well as React state. applyStreamEvent reads
          // from the cache — if the placeholder only lives in React state, stream
          // events can't find it and the first updateSessionMessages call
          // overwrites state back to the stale cache (losing the placeholder).
          updateSessionMessages(sessionId, (prev) => {
            if (prev.some((m) => m.id === assistantId)) return prev;
            return [
              ...prev,
              {
                id: assistantId,
                role: "assistant" as const,
                contentBlocks: [],
              },
            ];
          });
        }

        if (!resumedRunId && replayCount === 0) return;

        // The original listener remains subscribed across a reconnect. When
        // there is no active run, let one replay listener own all known runs so
        // missed events cannot be applied once by each listener.
        const replayResolvers = new Map<string, () => void>();
        if (!resumedRunId) {
          for (const [runId, listener] of runListenerByRunIdRef.current) {
            if (listener.resolve) replayResolvers.set(runId, listener.resolve);
          }
          for (const listener of [...runListenerByRunIdRef.current.values()]) {
            listener.cleanup();
          }
        }

        // The server clears activeRunId before replaying terminal events. Register
        // after every resume ACK so its preceding persistence marker is not lost.
        let remainingReplayEvents = replayCount;
        let unsub = () => {};
        const cleanupResumedListener = () => {
          unsub();
          if (
            resumedRunId &&
            runListenerByRunIdRef.current.get(resumedRunId)?.cleanup ===
              cleanupResumedListener
          ) {
            runListenerByRunIdRef.current.delete(resumedRunId);
          }
        };
        unsub = ws.onEvent((evt) => {
          if (!resumedRunId && remainingReplayEvents > 0) {
            remainingReplayEvents -= 1;
          }
          if (evt.type === "canvas.sync") {
            if (evt.canvasId === canvasId) onCanvasSync?.(evt);
            if (!resumedRunId && remainingReplayEvents === 0) unsub();
            return;
          }

          if (resumedRunId) {
            if (evt.runId !== resumedRunId) return;
            const assistantId = assistantIdByRunIdRef.current.get(evt.runId);
            if (!assistantId) return;

            applyStreamEvent(evt, assistantId, sessionId);
            onStreamEvent?.(evt);

            if (evt.type === "assistant.persistence_failed") {
              persistAssistantFallback(sessionId, evt.runId);
            }

            if (
              evt.type === "run.completed" ||
              evt.type === "run.failed" ||
              evt.type === "run.canceled"
            ) {
              void refreshAttachmentRecovery(sessionId);
              setActiveRunId(null);
              setStreaming(false);
              cleanupResumedListener();
            }
            return;
          }

          // A terminal replay with no active run may belong to a different chat
          // session on this canvas. Only recover a response this sidebar owns.
          if (
            evt.type === "assistant.persistence_failed" &&
            evt.sessionId === sessionId &&
            evt.assistant
          ) {
            persistRecoveredAssistantFallback(
              sessionId,
              evt.runId,
              evt.assistant,
            );
            if (remainingReplayEvents === 0) unsub();
            return;
          }
          if (!assistantIdByRunIdRef.current.has(evt.runId)) {
            if (remainingReplayEvents === 0) unsub();
            return;
          }
          const assistantId = assistantIdByRunIdRef.current.get(evt.runId);
          if (assistantId) {
            applyStreamEvent(evt, assistantId, sessionId);
            onStreamEvent?.(evt);
          }
          if (evt.type === "assistant.persistence_failed") {
            persistAssistantFallback(sessionId, evt.runId);
            if (remainingReplayEvents === 0) unsub();
            return;
          }
          if (
            evt.type === "run.completed" ||
            evt.type === "run.failed" ||
            evt.type === "run.canceled"
          ) {
            void refreshAttachmentRecovery(sessionId);
            replayResolvers.get(evt.runId)?.();
            if (remainingReplayEvents === 0) unsub();
            return;
          }
          if (remainingReplayEvents === 0) unsub();
        });
        if (resumedRunId) {
          const assistantId = assistantIdByRunIdRef.current.get(resumedRunId);
          if (assistantId) {
            runListenerByRunIdRef.current.set(resumedRunId, {
              assistantId,
              cleanup: cleanupResumedListener,
            });
          }
        }
      });
    })();
  }, [
    ws.connected,
    ws,
    canvasId,
    sessionsLoading,
    applyStreamEvent,
    onStreamEvent,
    onCanvasSync,
    activeSessionIdRef,
    reloadMessages,
    updateSessionMessages,
    setStreaming,
    initialPrompt,
    refreshAttachmentRecovery,
    persistAssistantFallback,
    persistRecoveredAssistantFallback,
  ]);

  // ── Collapsed state ──
  if (!open) {
    return (
      <div className="absolute right-3 top-3 z-20">
        <button
          onClick={onToggle}
          type="button"
          className="group inline-flex items-center gap-1 rounded-xl bg-card/80 backdrop-blur-sm border border-border px-2.5 py-1.5 text-xs text-foreground/60 shadow-sm hover:bg-card hover:text-foreground transition-colors cursor-pointer md:px-2.5 md:py-1.5 min-h-[36px] md:min-h-0"
        >
          <svg className="size-4 md:size-3.5" viewBox="0 0 24 24" fill="none">
            <path
              fill="currentColor"
              fillOpacity={0.9}
              d="M18.25 3c2.071 0 3.946 2.16 3.946 4.23L22 15.75a3.75 3.75 0 0 1-3.75 3.75h-2.874a.25.25 0 0 0-.16.058l-2.098 1.738a1.75 1.75 0 0 1-2.24-.007l-2.065-1.73a.25.25 0 0 0-.162-.059H5.75A3.75 3.75 0 0 1 2 15.75v-9A3.75 3.75 0 0 1 5.75 3zM7.5 10q-.053 0-.104.005a1.25 1.25 0 0 0-1.14 1.117l-.006.128.007.128a1.25 1.25 0 1 0 1.37-1.371l-.02-.002A1 1 0 0 0 7.5 10m4.5 0q-.053 0-.104.005a1.25 1.25 0 0 0-1.14 1.117l-.006.128.007.128a1.25 1.25 0 1 0 1.37-1.371l-.02-.002A1 1 0 0 0 12 10m4.5 0q-.053 0-.105.005a1.25 1.25 0 0 0-1.138 1.117l-.007.128.007.128a1.25 1.25 0 1 0 1.37-1.371l-.02-.002A1 1 0 0 0 16.5 10"
            />
          </svg>
          对话
        </button>
      </div>
    );
  }

  // Shared event isolation — prevent keyboard/clipboard events from bleeding
  // into Excalidraw canvas when the sidebar has focus.
  const eventIsolationProps = {
    onKeyDown: (e: React.KeyboardEvent) => e.stopPropagation(),
    onKeyUp: (e: React.KeyboardEvent) => e.stopPropagation(),
    onCopy: (e: React.ClipboardEvent) => e.stopPropagation(),
    onCut: (e: React.ClipboardEvent) => e.stopPropagation(),
    onPaste: (e: React.ClipboardEvent) => e.stopPropagation(),
    onWheel: (e: React.WheelEvent) => e.stopPropagation(),
  };

  // The inner panel content is shared across all breakpoints.
  // Extracted as a variable to avoid duplicating the chat UI tree
  // between overlay (mobile/tablet) and inline (desktop) render paths.
  const panelContent = (
    <>
      {/* Header */}
      <div className="flex min-h-[48px] items-center justify-between pl-4 pr-2">
        <div className="flex items-center gap-1 min-w-0">
          <h2 className="text-sm font-semibold text-foreground shrink-0">
            Loomic Agent
          </h2>
          {!sessionsLoading && (
            <SessionSelector
              sessions={sessions}
              activeSessionId={activeSessionId}
              onSelect={handleSelectSession}
              onNewChat={handleNewChat}
              onDelete={handleDeleteSession}
              hasMore={hasOlderSessions}
              loadingMore={loadingOlderSessions}
              onLoadMore={() => void loadOlderSessions()}
            />
          )}
        </div>
        <button
          type="button"
          onClick={onToggle}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors shrink-0"
          title="Collapse panel"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none">
            <path
              d="M4 3.25a.75.75 0 0 1 .75.75v16a.75.75 0 0 1-1.5 0V4A.75.75 0 0 1 4 3.25m9.47 2.22a.75.75 0 0 1 1.06 0l6 6a.75.75 0 0 1 0 1.06l-6 6a.75.75 0 1 1-1.06-1.06l4.72-4.72H8a.75.75 0 0 1 0-1.5h10.19l-4.72-4.72a.75.75 0 0 1 0-1.06"
              fill="currentColor"
            />
          </svg>
        </button>
      </div>

      {/* Disconnected banner */}
      {!ws.connected && (
        <div className="flex items-center gap-2 px-4 py-2 bg-muted border-b border-border">
          <div className="h-2 w-2 rounded-full bg-red-500 animate-[pulse_1.2s_ease-in-out_infinite]" />
          <span className="text-[11px] text-muted-foreground">
            连接已断开，正在重连...
          </span>
        </div>
      )}

      {/* Messages */}
      <ErrorBoundary
        onError={(err) =>
          console.error("[chat-sidebar] message area render crashed:", err)
        }
      >
        <div
          ref={messagesViewportRef}
          className="flex-1 overflow-y-auto overflow-x-hidden flex flex-col gap-6 px-4 py-4"
          aria-live="polite"
          aria-relevant="additions"
        >
          {hasOlderMessages && (
            <button
              type="button"
              disabled={loadingOlderMessages}
              onClick={() => void handleLoadOlderMessages()}
              className="mx-auto min-h-8 rounded-md border border-border px-3 text-xs text-muted-foreground disabled:opacity-50"
            >
              {loadingOlderMessages ? "Loading..." : "Load older messages"}
            </button>
          )}
          {sessionsLoading || messagesLoading ? (
            <div className="flex h-full items-center justify-center">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-foreground" />
            </div>
          ) : messages.length === 0 ? (
            <ChatSkills onSend={handleSend} />
          ) : (
            messages.map((msg) => (
              <div
                key={msg.id}
                className="flex flex-col gap-2"
                data-message-id={msg.id}
              >
                <ChatMessage
                  role={msg.role}
                  contentBlocks={msg.contentBlocks}
                  isStreaming={
                    streaming &&
                    msg.role === "assistant" &&
                    msg === messages[messages.length - 1]
                  }
                  onRetryAttachment={handleRetryAttachment}
                />
                {pendingAcceptanceRetry?.assistantId === msg.id && (
                  <button
                    type="button"
                    className="inline-flex h-8 w-fit items-center gap-1.5 rounded-md border border-border px-2.5 text-xs text-foreground hover:bg-muted"
                    onClick={pendingAcceptanceRetry.retry}
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    重试
                  </button>
                )}
              </div>
            ))
          )}
          <div ref={messagesEndRef} />
        </div>
      </ErrorBoundary>

      {/* Input */}
      <div className="relative">
        {atQuery !== null && mentionPickerItems.length > 0 && (
          <MessageMentionPicker
            items={mentionPickerItems}
            query={atQuery}
            onSelect={(item) => {
              handleMentionSelect(item);
              chatInputRef.current?.clearAtQuery();
              setAtQuery(null);
            }}
            onClose={() => setAtQuery(null)}
          />
        )}
        <ChatInput
          ref={chatInputRef}
          onSend={handleSend}
          running={streaming}
          {...(activeRunId
            ? {
                onStop: () => {
                  console.info("[chat] canceling active Agent run", {
                    runId: activeRunId,
                  });
                  abortRef.current = true;
                  ws.cancelRun(activeRunId);
                },
              }
            : {})}
          disabled={streaming || sessionsLoading}
          attachments={imageAttachments}
          onAddFiles={addFiles}
          onRemoveAttachment={removeAttachment}
          onRetryAttachment={retryUpload}
          isUploading={isUploading}
          onAtQuery={setAtQuery}
          mentions={messageMentions}
          onRemoveMention={handleRemoveMention}
          {...(selectedCanvasElements ? { selectedCanvasElements } : {})}
        />
      </div>
    </>
  );

  const creditDialogEl = creditDialog && (
    <CreditInsufficientDialog
      open={creditDialog.open}
      onClose={() => setCreditDialog(null)}
      currentBalance={creditDialog.currentBalance}
      requiredAmount={creditDialog.requiredAmount}
      plan={creditDialog.plan}
      dailyClaimed={creditDialog.dailyClaimed}
      onClaimDaily={async () => {
        await claimDailyCredits(accessTokenRef.current);
      }}
    />
  );

  // ── Mobile / Tablet: full-screen overlay with backdrop ──
  if (isOverlay) {
    return (
      <>
        {/* Semi-transparent backdrop — click to close */}
        {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- backdrop is a non-interactive dismissal layer, keyboard close is handled via Escape */}
        <div
          className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] animate-in fade-in duration-200"
          onClick={onToggle}
        />
        {/* Chat panel — full screen on mobile, fixed-width drawer on tablet */}
        <div
          className={
            breakpoint === "mobile"
              ? "fixed inset-0 z-50 flex flex-col bg-card animate-in slide-in-from-right duration-250"
              : "fixed inset-y-0 right-0 z-50 flex w-[400px] flex-col border-l border-border bg-card shadow-2xl animate-in slide-in-from-right duration-250"
          }
          {...eventIsolationProps}
        >
          {panelContent}
        </div>
        {creditDialogEl}
      </>
    );
  }

  // ── Desktop: inline side-by-side with resize handle ──
  return (
    <div
      className="flex h-full shrink-0"
      style={{ width: sidebarWidth }}
      {...eventIsolationProps}
    >
      {/* Resize handle -- supports mouse, touch, and keyboard (ArrowLeft/ArrowRight) */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize chat panel"
        aria-valuenow={sidebarWidth}
        aria-valuemin={SIDEBAR_MIN}
        aria-valuemax={SIDEBAR_MAX}
        tabIndex={0}
        className="w-2 shrink-0 cursor-col-resize bg-gradient-to-r from-transparent via-border to-transparent shadow-[1px_0_10px_rgba(15,23,42,0.06)] transition-all hover:via-muted-foreground/40 hover:shadow-[1px_0_14px_rgba(15,23,42,0.1)] active:via-muted-foreground/60 active:shadow-[1px_0_16px_rgba(15,23,42,0.14)] outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
        onKeyDown={handleResizeKeyDown}
      />
      <div className="flex flex-1 flex-col bg-card min-w-0">{panelContent}</div>
      {creditDialogEl}
    </div>
  );
}
