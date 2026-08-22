"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

import { fetchBrandKitsPage } from "../api/brand-kits";
import { fetchChatMessagesPage, fetchChatSessionsPage } from "../api/chat";
import { fetchCreditTransactionsPage } from "../api/credits";
import {
  fetchAgentModels,
  fetchImageModels,
  fetchVideoModels,
} from "../api/models";
import { fetchProjectsPage } from "../api/projects";
import { fetchViewer } from "../api/viewer";
import { queryKeys } from "./keys";

type TokenGetter = () => string | null;
type WorkspaceQueryOptions = {
  userId: string;
  workspaceId: string | undefined;
  getAccessToken: TokenGetter;
};
type PaginationFilters = { limit?: number };

function requireToken(getAccessToken: TokenGetter): string {
  const token = getAccessToken();
  if (!token) throw new Error("Authenticated query requires an access token");
  return token;
}

function isAuthenticatedWorkspace(
  options: WorkspaceQueryOptions | undefined,
): options is WorkspaceQueryOptions & { workspaceId: string } {
  return Boolean(options?.workspaceId);
}

export function useViewerQuery(
  userId: string | undefined,
  getAccessToken: TokenGetter,
) {
  return useQuery({
    queryKey: userId ? queryKeys.viewer(userId) : queryKeys.disabled("viewer"),
    enabled: Boolean(userId),
    queryFn: ({ signal }) =>
      fetchViewer(requireToken(getAccessToken), { signal }),
  });
}

export function useProjectsInfiniteQuery(
  options: WorkspaceQueryOptions & PaginationFilters,
) {
  const { userId, workspaceId, getAccessToken, limit } = options;
  return useInfiniteQuery({
    queryKey: workspaceId
      ? queryKeys.workspace.projects(userId, workspaceId, { limit })
      : queryKeys.disabled("projects"),
    enabled: Boolean(workspaceId),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      fetchProjectsPage(
        requireToken(getAccessToken),
        { cursor: pageParam, ...(limit === undefined ? {} : { limit }) },
        { signal },
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}

export function useBrandKitsInfiniteQuery(
  options: WorkspaceQueryOptions & PaginationFilters,
) {
  const { userId, workspaceId, getAccessToken, limit } = options;
  return useInfiniteQuery({
    queryKey: workspaceId
      ? queryKeys.workspace.brandKits(userId, workspaceId, { limit })
      : queryKeys.disabled("brand-kits"),
    enabled: Boolean(workspaceId),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      fetchBrandKitsPage(
        requireToken(getAccessToken),
        { cursor: pageParam, ...(limit === undefined ? {} : { limit }) },
        { signal },
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}

export function useCreditTransactionsInfiniteQuery(
  options: WorkspaceQueryOptions & PaginationFilters,
) {
  const { userId, workspaceId, getAccessToken, limit } = options;
  return useInfiniteQuery({
    queryKey: workspaceId
      ? queryKeys.workspace.creditTransactions(userId, workspaceId, { limit })
      : queryKeys.disabled("credit-transactions"),
    enabled: Boolean(workspaceId),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      fetchCreditTransactionsPage(
        requireToken(getAccessToken),
        { cursor: pageParam, ...(limit === undefined ? {} : { limit }) },
        { signal },
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}

export function useChatSessionsInfiniteQuery(
  options: WorkspaceQueryOptions & PaginationFilters & { canvasId: string },
) {
  const { userId, workspaceId, canvasId, getAccessToken, limit } = options;
  return useInfiniteQuery({
    queryKey: workspaceId
      ? queryKeys.workspace.chatSessions(userId, workspaceId, canvasId, {
          limit,
        })
      : queryKeys.disabled("chat-sessions"),
    enabled: Boolean(workspaceId),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      fetchChatSessionsPage(
        requireToken(getAccessToken),
        canvasId,
        { cursor: pageParam, ...(limit === undefined ? {} : { limit }) },
        { signal },
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}

export function useChatMessagesInfiniteQuery(
  options: WorkspaceQueryOptions &
    PaginationFilters & { canvasId: string; sessionId: string },
) {
  const { userId, workspaceId, canvasId, sessionId, getAccessToken, limit } =
    options;
  return useInfiniteQuery({
    queryKey: workspaceId
      ? queryKeys.workspace.chatMessages(
          userId,
          workspaceId,
          canvasId,
          sessionId,
          { limit },
        )
      : queryKeys.disabled("chat-messages"),
    enabled: Boolean(workspaceId && sessionId),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      fetchChatMessagesPage(
        requireToken(getAccessToken),
        sessionId,
        { cursor: pageParam, ...(limit === undefined ? {} : { limit }) },
        { signal },
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}

export function useAgentModelsQuery() {
  return useQuery({
    queryKey: queryKeys.public.models.agent,
    queryFn: ({ signal }) => fetchAgentModels({ signal }),
  });
}

export function useImageModelsQuery(options?: WorkspaceQueryOptions) {
  const authenticated = isAuthenticatedWorkspace(options);
  return useQuery({
    queryKey: options
      ? authenticated
        ? queryKeys.workspace.models.image(
            options.userId,
            options.workspaceId,
            {},
          )
        : queryKeys.disabled("image-models")
      : queryKeys.public.models.image({}),
    enabled: !options || authenticated,
    queryFn: ({ signal }) =>
      fetchImageModels({
        ...(authenticated
          ? { accessToken: requireToken(options.getAccessToken) }
          : {}),
        signal,
      }),
  });
}

export function useVideoModelsQuery(options?: WorkspaceQueryOptions) {
  const authenticated = isAuthenticatedWorkspace(options);
  return useQuery({
    queryKey: options
      ? authenticated
        ? queryKeys.workspace.models.video(
            options.userId,
            options.workspaceId,
            {},
          )
        : queryKeys.disabled("video-models")
      : queryKeys.public.models.video({}),
    enabled: !options || authenticated,
    queryFn: ({ signal }) =>
      fetchVideoModels({
        ...(authenticated
          ? { accessToken: requireToken(options.getAccessToken) }
          : {}),
        signal,
      }),
  });
}
