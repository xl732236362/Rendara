"use client";

import { useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { ChatSessionSummary, ContentBlock } from "@loomic/shared";
import type { ChatMessage as ChatMessageData } from "@loomic/shared";
import { ApiApplicationError } from "../lib/api-client";
import { useAuth } from "../lib/auth-context";
import { queryKeys } from "../lib/query/keys";
import {
  useChatMessagesInfiniteQuery,
  useChatSessionsInfiniteQuery,
  useViewerQuery,
} from "../lib/query/workspace-queries";
import {
  createSession,
  deleteSession as deleteSessionApi,
  updateSessionTitle,
} from "../lib/server-api";

// ── Types ────────────────────────────────────────────────────

export type Message = {
  id: string;
  role: "user" | "assistant";
  contentBlocks: ContentBlock[];
};

function messageText(message: Message): string {
  return message.contentBlocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export function mergeReloadedMessages(
  serverMessages: Message[],
  cachedMessages: Message[],
  preserveLocalMessageIds: ReadonlySet<string>,
): Message[] {
  const serverAssistantText = new Set(
    serverMessages
      .filter((message) => message.role === "assistant")
      .map(messageText)
      .filter(Boolean),
  );
  const hasServerAssistantReplacement = (message: Message) => {
    if (message.role !== "assistant") return false;
    const localText = messageText(message);
    if (!localText) return false;
    return [...serverAssistantText].some(
      (serverText) =>
        serverText.startsWith(localText) || localText.startsWith(serverText),
    );
  };
  const preserved = cachedMessages.filter(
    (message) =>
      preserveLocalMessageIds.has(message.id) &&
      !serverMessages.some(
        (serverMessage) => serverMessage.id === message.id,
      ) &&
      !hasServerAssistantReplacement(message),
  );
  return [...serverMessages, ...preserved];
}

// ── Helpers ──────────────────────────────────────────────────

export function mapServerMessages(
  serverMessages: ChatMessageData[],
): Message[] {
  return serverMessages.map((m) => {
    let blocks: ContentBlock[];
    if (m.contentBlocks && m.contentBlocks.length > 0) {
      blocks = m.contentBlocks;
    } else {
      blocks = [];
      if (m.content) {
        blocks.push({ type: "text", text: m.content });
      }
      if (m.toolActivities) {
        for (const ta of m.toolActivities) {
          blocks.push({
            type: "tool",
            toolCallId: ta.toolCallId,
            toolName: ta.toolName,
            status: ta.status,
            ...(ta.input ? { input: ta.input } : {}),
            ...(ta.output ? { output: ta.output } : {}),
            ...(ta.outputSummary ? { outputSummary: ta.outputSummary } : {}),
            ...(ta.artifacts ? { artifacts: ta.artifacts } : {}),
            ...(ta.error ? { error: ta.error } : {}),
            ...(ta.recovery ? { recovery: ta.recovery } : {}),
          });
        }
      }
    }
    return { id: m.id, role: m.role, contentBlocks: blocks };
  });
}

export function mergeMessagePages(
  pages: readonly { items: ChatMessageData[] }[],
): ChatMessageData[] {
  const seen = new Set<string>();
  return [...pages]
    .reverse()
    .flatMap((page) => page.items)
    .filter((message) => {
      if (seen.has(message.id)) return false;
      seen.add(message.id);
      return true;
    });
}

function uniqueMessages(messages: Message[]): Message[] {
  const byId = new Map<string, Message>();
  for (const message of messages) byId.set(message.id, message);
  return [...byId.values()];
}

export function isInvalidCursorError(
  error: unknown,
): error is ApiApplicationError {
  return (
    error instanceof ApiApplicationError && error.code === "invalid_cursor"
  );
}

// ── Hook ─────────────────────────────────────────────────────

type UseChatSessionsOptions = {
  canvasId: string;
  accessToken: string;
  initialSessionId?: string | undefined;
  onSessionChange?: ((sessionId: string) => void) | undefined;
};

export function useChatSessions({
  canvasId,
  accessToken,
  initialSessionId,
  onSessionChange,
}: UseChatSessionsOptions) {
  const { user } = useAuth();
  const userId = user?.id;
  const queryClient = useQueryClient();
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);

  // Refs to avoid stale closures in callbacks
  const accessTokenRef = useRef(accessToken);
  accessTokenRef.current = accessToken;
  const activeSessionIdRef = useRef(activeSessionId);
  const sessionsRef = useRef(sessions);
  const messagesRef = useRef(messages);
  const onSessionChangeRef = useRef(onSessionChange);
  onSessionChangeRef.current = onSessionChange;
  const getToken = useCallback(() => accessTokenRef.current ?? null, []);
  const viewer = useViewerQuery(userId, getToken);
  const workspaceId = viewer.data?.workspace.id;
  const ownerKey =
    userId && workspaceId ? `${userId}:${workspaceId}:${canvasId}` : null;
  const ownerKeyRef = useRef(ownerKey);
  ownerKeyRef.current = ownerKey;
  const [activeOwnerKey, setActiveOwnerKey] = useState<string | null>(null);
  const ownsControllerState = ownerKey !== null && activeOwnerKey === ownerKey;
  const effectiveSessionId = ownsControllerState ? activeSessionId : null;
  activeSessionIdRef.current = effectiveSessionId;
  sessionsRef.current = ownsControllerState ? sessions : [];
  messagesRef.current = ownsControllerState ? messages : [];
  const sessionsQuery = useChatSessionsInfiniteQuery({
    userId: userId ?? "disabled",
    workspaceId,
    canvasId,
    getAccessToken: getToken,
    limit: 20,
  });
  const messagesQuery = useChatMessagesInfiniteQuery({
    userId: userId ?? "disabled",
    workspaceId,
    canvasId,
    sessionId: effectiveSessionId ?? "",
    getAccessToken: getToken,
    limit: 30,
  });
  const sessionsKey = useMemo(
    () =>
      userId && workspaceId
        ? queryKeys.workspace.chatSessions(userId, workspaceId, canvasId, {
            limit: 20,
          })
        : null,
    [canvasId, userId, workspaceId],
  );
  const messagesKey = useMemo(
    () =>
      userId && workspaceId && effectiveSessionId
        ? queryKeys.workspace.chatMessages(
            userId,
            workspaceId,
            canvasId,
            effectiveSessionId,
            { limit: 30 },
          )
        : null,
    [effectiveSessionId, canvasId, userId, workspaceId],
  );
  const overlayRef = useRef(new Map<string, Message[]>());
  const creatingInitialSessionRef = useRef(false);
  const invalidCursorRecoveryRef = useRef(
    new Map<string, ApiApplicationError>(),
  );

  useLayoutEffect(() => {
    if (activeOwnerKey === ownerKey) return;
    setActiveOwnerKey(ownerKey);
    setActiveSessionId(null);
    setSessions([]);
    setMessages([]);
    setSessionsLoading(Boolean(ownerKey));
    setMessagesLoading(false);
    setStreaming(false);
    activeSessionIdRef.current = null;
    sessionsRef.current = [];
    messagesRef.current = [];
    overlayRef.current.clear();
    invalidCursorRecoveryRef.current.clear();
    creatingInitialSessionRef.current = false;
  }, [activeOwnerKey, ownerKey]);

  // ── Update messages for a specific session ──
  // Always writes to cache; only syncs to React state if the session is visible.
  const updateSessionMessages = useCallback(
    (targetSessionId: string, updater: (prev: Message[]) => Message[]) => {
      const prev =
        overlayRef.current.get(targetSessionId) ??
        (activeSessionIdRef.current === targetSessionId
          ? messagesRef.current
          : []);
      const next = uniqueMessages(updater(prev));
      overlayRef.current.set(targetSessionId, next);
      if (activeSessionIdRef.current === targetSessionId) {
        setMessages(next);
      }
    },
    [],
  );

  const getSessionMessages = useCallback(
    (sessionId: string) =>
      overlayRef.current.get(sessionId) ??
      (activeSessionIdRef.current === sessionId ? messagesRef.current : []),
    [],
  );

  // Durable pages are owned by React Query; this controller only selects a
  // session and layers pending/streaming messages over persisted records.
  useEffect(() => {
    if (!sessionsQuery.data) return;
    const seen = new Set<string>();
    const durableSessions = sessionsQuery.data.pages.flatMap((page) =>
      page.items.filter((session) => {
        if (seen.has(session.id)) return false;
        seen.add(session.id);
        return true;
      }),
    );
    setSessions(durableSessions);
    setSessionsLoading(false);
    if (durableSessions.length === 0) {
      if (creatingInitialSessionRef.current) return;
      const initiatingOwner = ownerKey;
      if (!initiatingOwner) return;
      creatingInitialSessionRef.current = true;
      void createSession(accessTokenRef.current, canvasId)
        .then((created) => {
          if (ownerKeyRef.current !== initiatingOwner) return;
          setSessions([created.session]);
          setActiveSessionId(created.session.id);
          onSessionChangeRef.current?.(created.session.id);
          if (sessionsKey) {
            void queryClient.resetQueries({
              queryKey: sessionsKey,
              exact: true,
            });
          }
        })
        .catch(() => {})
        .finally(() => {
          if (ownerKeyRef.current === initiatingOwner) {
            creatingInitialSessionRef.current = false;
          }
        });
      return;
    }
    if (activeSessionIdRef.current) return;
    const target =
      (initialSessionId
        ? durableSessions.find((session) => session.id === initialSessionId)
        : undefined) ?? durableSessions[0];
    if (!target) return;
    setMessagesLoading(true);
    setActiveSessionId(target.id);
    onSessionChangeRef.current?.(target.id);
  }, [
    canvasId,
    initialSessionId,
    queryClient,
    sessionsKey,
    sessionsQuery.data,
    ownerKey,
  ]);

  useEffect(() => {
    if (!effectiveSessionId || !messagesQuery.data) return;
    const durable = mapServerMessages(
      mergeMessagePages(messagesQuery.data.pages),
    );
    const overlay = overlayRef.current.get(effectiveSessionId) ?? [];
    const next = mergeReloadedMessages(
      durable,
      overlay,
      new Set(overlay.map((message) => message.id)),
    );
    const pendingOverlay = next.filter(
      (message) => !durable.some((item) => item.id === message.id),
    );
    if (pendingOverlay.length > 0) {
      overlayRef.current.set(effectiveSessionId, pendingOverlay);
    } else {
      overlayRef.current.delete(effectiveSessionId);
    }
    setMessages(next);
    setMessagesLoading(false);
  }, [effectiveSessionId, messagesQuery.data]);

  useEffect(() => {
    if (sessionsQuery.error) setSessionsLoading(false);
  }, [sessionsQuery.error]);

  useEffect(() => {
    if (messagesQuery.error) setMessagesLoading(false);
  }, [messagesQuery.error]);

  const recoverInvalidCursor = useCallback(
    async (
      key: readonly unknown[],
      error: ApiApplicationError,
      scope: "sessions" | "messages",
      refetch: () => Promise<unknown>,
    ) => {
      const resetId = JSON.stringify(key);
      if (invalidCursorRecoveryRef.current.has(resetId)) return;
      invalidCursorRecoveryRef.current.set(resetId, error);
      await queryClient.cancelQueries({ queryKey: key, exact: true });
      queryClient.removeQueries({ queryKey: key, exact: true });
      console.warn("[chat.query] invalid_cursor_reset", {
        canvasId,
        scope,
      });
      await refetch();
    },
    [canvasId, queryClient],
  );

  useEffect(() => {
    if (sessionsKey && sessionsQuery.isSuccess) {
      invalidCursorRecoveryRef.current.delete(JSON.stringify(sessionsKey));
    }
  }, [sessionsKey, sessionsQuery.isSuccess]);

  useEffect(() => {
    if (messagesKey && messagesQuery.isSuccess) {
      invalidCursorRecoveryRef.current.delete(JSON.stringify(messagesKey));
    }
  }, [messagesKey, messagesQuery.isSuccess]);

  useEffect(() => {
    const error = sessionsQuery.error;
    if (!sessionsKey || !isInvalidCursorError(error)) return;
    void recoverInvalidCursor(
      sessionsKey,
      error,
      "sessions",
      sessionsQuery.refetch,
    );
  }, [
    recoverInvalidCursor,
    sessionsKey,
    sessionsQuery.error,
    sessionsQuery.refetch,
  ]);

  useEffect(() => {
    const error = messagesQuery.error;
    if (!messagesKey || !isInvalidCursorError(error)) return;
    void recoverInvalidCursor(
      messagesKey,
      error,
      "messages",
      messagesQuery.refetch,
    );
  }, [
    messagesKey,
    messagesQuery.error,
    messagesQuery.refetch,
    recoverInvalidCursor,
  ]);

  const retrySessions = useCallback(async () => {
    setSessionsLoading(true);
    try {
      await sessionsQuery.refetch();
    } finally {
      setSessionsLoading(false);
    }
  }, [sessionsQuery.refetch]);

  const retryMessages = useCallback(async () => {
    setMessagesLoading(true);
    try {
      await messagesQuery.refetch();
    } finally {
      setMessagesLoading(false);
    }
  }, [messagesQuery.refetch]);

  // ── Session switch ──
  const handleSelectSession = useCallback(
    async (sessionId: string) => {
      if (sessionId === activeSessionIdRef.current) return;
      if (streaming) setStreaming(false);
      setActiveSessionId(sessionId);
      onSessionChangeRef.current?.(sessionId);

      setMessages(overlayRef.current.get(sessionId) ?? []);
      setMessagesLoading(true);
    },
    [streaming],
  );

  // ── New chat ──
  const handleNewChat = useCallback(async () => {
    if (streaming) setStreaming(false);
    const initiatingOwner = ownerKeyRef.current;
    if (!initiatingOwner) return;
    try {
      const res = await createSession(accessTokenRef.current, canvasId);
      if (ownerKeyRef.current !== initiatingOwner) return;
      setSessions((prev) => [res.session, ...prev]);
      setActiveSessionId(res.session.id);
      onSessionChangeRef.current?.(res.session.id);
      setMessages([]);
      if (sessionsKey) {
        void queryClient.resetQueries({ queryKey: sessionsKey, exact: true });
      }
    } catch {
      // Silently fail
    }
  }, [canvasId, queryClient, sessionsKey, streaming]);

  // ── Delete session ──
  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      if (streaming || !sessionId) return;
      const token = accessTokenRef.current;
      const remaining = sessionsRef.current.filter((s) => s.id !== sessionId);

      if (remaining.length === 0) {
        const initiatingOwner = ownerKeyRef.current;
        if (!initiatingOwner) return;
        try {
          const res = await createSession(token, canvasId);
          if (ownerKeyRef.current !== initiatingOwner) return;
          setSessions([res.session]);
          setActiveSessionId(res.session.id);
          onSessionChangeRef.current?.(res.session.id);
          setMessages([]);
        } catch {
          return;
        }
      } else {
        setSessions(remaining);
        if (sessionId === activeSessionIdRef.current) {
          const next = remaining[0]!;
          setActiveSessionId(next.id);
          onSessionChangeRef.current?.(next.id);
          setMessagesLoading(true);
          setMessages(overlayRef.current.get(next.id) ?? []);
        }
      }

      // Delete in background
      const reconcileSessions = () => {
        if (sessionsKey) {
          void queryClient.resetQueries({
            queryKey: sessionsKey,
            exact: true,
          });
        }
      };
      void deleteSessionApi(token, sessionId).then(
        reconcileSessions,
        reconcileSessions,
      );

      // Clean up cached messages for deleted session
      overlayRef.current.delete(sessionId);
    },
    [canvasId, queryClient, sessionsKey, streaming],
  );

  // ── Auto-title first message ──
  const autoTitleSession = useCallback(
    (text: string) => {
      const currentSessionId = activeSessionIdRef.current;
      if (!currentSessionId) return;
      const isFirstMessage = messagesRef.current.length === 0;
      if (!isFirstMessage) return;

      const title = text.length > 50 ? `${text.slice(0, 47)}...` : text;
      void updateSessionTitle(
        accessTokenRef.current,
        currentSessionId,
        title,
      ).then(
        () => {
          if (sessionsKey) {
            void queryClient.resetQueries({
              queryKey: sessionsKey,
              exact: true,
            });
          }
        },
        () => {
          console.warn("[chat.query] title_update_failed", {
            canvasId,
            sessionId: currentSessionId,
          });
        },
      );
      setSessions((prev) =>
        prev.map((s) => (s.id === currentSessionId ? { ...s, title } : s)),
      );
    },
    [canvasId, queryClient, sessionsKey],
  );

  // ── Reload messages (for reconnection) ──
  const reloadMessages = useCallback(
    async (
      sessionId: string,
      preserveLocalMessageIds: ReadonlySet<string> = new Set(),
    ) => {
      if (!sessionId) {
        console.warn(
          "[chat] reloadMessages called with empty sessionId, skipping",
        );
        return;
      }
      try {
        const existing = overlayRef.current.get(sessionId) ?? [];
        overlayRef.current.set(
          sessionId,
          existing.filter((message) => preserveLocalMessageIds.has(message.id)),
        );
        if (sessionId === activeSessionIdRef.current) {
          setMessagesLoading(true);
          try {
            await messagesQuery.refetch();
          } finally {
            setMessagesLoading(false);
          }
        } else if (userId && workspaceId) {
          await queryClient.resetQueries({
            queryKey: queryKeys.workspace.chatMessages(
              userId,
              workspaceId,
              canvasId,
              sessionId,
              { limit: 30 },
            ),
            exact: true,
          });
        }
      } catch {
        console.warn("[chat.query] reconnect_reload_failed", {
          canvasId,
          sessionId,
        });
      }
    },
    [canvasId, messagesQuery.refetch, queryClient, userId, workspaceId],
  );

  return {
    sessions: ownsControllerState ? sessions : [],
    activeSessionId: effectiveSessionId,
    activeSessionIdRef,
    messages: ownsControllerState ? messages : [],
    messagesRef,
    setMessages,
    sessionsLoading,
    messagesLoading,
    sessionsError:
      sessionsQuery.error &&
      !isInvalidCursorError(sessionsQuery.error) &&
      !sessionsQuery.isFetching
        ? "Unable to load chat history."
        : null,
    messagesError:
      messagesQuery.error &&
      !isInvalidCursorError(messagesQuery.error) &&
      !messagesQuery.isFetching
        ? "Unable to load messages."
        : null,
    retrySessions,
    retryMessages,
    hasOlderSessions: sessionsQuery.hasNextPage,
    loadingOlderSessions: sessionsQuery.isFetchingNextPage,
    loadOlderSessions: sessionsQuery.fetchNextPage,
    hasOlderMessages: messagesQuery.hasNextPage,
    loadingOlderMessages: messagesQuery.isFetchingNextPage,
    loadOlderMessages: messagesQuery.fetchNextPage,
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
  };
}
