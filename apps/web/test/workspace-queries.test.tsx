// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fetchBrandKitsPage } from "../src/lib/api/brand-kits";
import {
  fetchChatMessagesPage,
  fetchChatSessionsPage,
} from "../src/lib/api/chat";
import { fetchCreditTransactionsPage } from "../src/lib/api/credits";
import { fetchProjectsPage } from "../src/lib/api/projects";
import {
  useAgentModelsQuery,
  useBrandKitsInfiniteQuery,
  useChatMessagesInfiniteQuery,
  useChatSessionsInfiniteQuery,
  useCreditTransactionsInfiniteQuery,
  useImageModelsQuery,
  useProjectsInfiniteQuery,
  useVideoModelsQuery,
  useViewerQuery,
} from "../src/lib/query/workspace-queries";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe("workspace query clients", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_SERVER_BASE_URL", "http://localhost:3001");
  });

  it("parses V2 cursor pages with shared runtime schemas", async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ items: [], nextCursor: "opaque.cursor" })),
    );

    await expect(
      fetchProjectsPage("token-1", { cursor: undefined, limit: 20 }),
    ).resolves.toEqual({ items: [], nextCursor: "opaque.cursor" });

    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ items: [], nextCursor: 42 })),
    );
    await expect(fetchProjectsPage("token-1", {})).rejects.toMatchObject({
      name: "ApiProtocolError",
    });
  });

  it.each([
    ["projects", (token: string) => fetchProjectsPage(token, {})],
    ["brand kits", (token: string) => fetchBrandKitsPage(token, {})],
    [
      "credit transactions",
      (token: string) => fetchCreditTransactionsPage(token, {}),
    ],
    [
      "chat sessions",
      (token: string) => fetchChatSessionsPage(token, "canvas-1", {}),
    ],
    [
      "chat messages",
      (token: string) => fetchChatMessagesPage(token, "session-1", {}),
    ],
  ])("runtime-parses valid and invalid %s V2 pages", async (_name, request) => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ items: [], nextCursor: null })),
    );
    await expect(request("token-1")).resolves.toEqual({
      items: [],
      nextCursor: null,
    });

    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ items: [{ invalid: true }], nextCursor: null }),
      ),
    );
    await expect(request("token-1")).rejects.toMatchObject({
      name: "ApiProtocolError",
    });
  });

  it.each([
    [
      "brand kits",
      () =>
        useBrandKitsInfiniteQuery({
          userId: "user-1",
          workspaceId: "workspace-1",
          getAccessToken: () => "brand-token",
        }),
      "/api/v2/brand-kits",
      "brand-token",
      ["users", "user-1", "workspaces", "workspace-1", "brand-kits", {}],
    ],
    [
      "credit transactions",
      () =>
        useCreditTransactionsInfiniteQuery({
          userId: "user-1",
          workspaceId: "workspace-1",
          getAccessToken: () => "credit-token",
        }),
      "/api/v2/credits/transactions",
      "credit-token",
      [
        "users",
        "user-1",
        "workspaces",
        "workspace-1",
        "credits",
        "transactions",
        {},
      ],
    ],
    [
      "chat sessions",
      () =>
        useChatSessionsInfiniteQuery({
          userId: "user-1",
          workspaceId: "workspace-1",
          canvasId: "canvas-1",
          getAccessToken: () => "session-token",
        }),
      "/api/v2/canvases/canvas-1/sessions",
      "session-token",
      [
        "users",
        "user-1",
        "workspaces",
        "workspace-1",
        "canvases",
        "canvas-1",
        "sessions",
        {},
      ],
    ],
    [
      "chat messages",
      () =>
        useChatMessagesInfiniteQuery({
          userId: "user-1",
          workspaceId: "workspace-1",
          canvasId: "canvas-1",
          sessionId: "session-1",
          getAccessToken: () => "message-token",
        }),
      "/api/v2/sessions/session-1/messages",
      "message-token",
      [
        "users",
        "user-1",
        "workspaces",
        "workspace-1",
        "canvases",
        "canvas-1",
        "sessions",
        "session-1",
        "messages",
        {},
      ],
    ],
  ])(
    "executes scoped %s hooks with bearer auth and Query signal",
    async (_name, hook, path, token, expectedKey) => {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [], nextCursor: null })),
      );

      const { result } = renderHook(hook as () => { isSuccess: boolean }, {
        wrapper: wrapper(client),
      });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      const [url, init] = mockFetch.mock.calls[0] ?? [];
      expect(url).toBe(`http://localhost:3001${path}`);
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Bearer ${token}`,
      );
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(
        client.getQueryCache().find({ queryKey: expectedKey, exact: true }),
      ).toBeDefined();
    },
  );

  it("reads the current token when the query executes and forwards its signal", async () => {
    let token = "fresh-token";
    const getAccessToken = vi.fn(() => token);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ items: [], nextCursor: null })),
    );

    const { result, rerender } = renderHook(
      ({ workspaceId }: { workspaceId: string | undefined }) =>
        useProjectsInfiniteQuery({
          userId: "user-1",
          workspaceId,
          getAccessToken,
        }),
      {
        wrapper: wrapper(client),
        initialProps: { workspaceId: undefined as string | undefined },
      },
    );
    token = "newest-token";
    rerender({ workspaceId: "workspace-1" });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [, init] = mockFetch.mock.calls[0] ?? [];
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer newest-token",
    );
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(getAccessToken).toHaveBeenCalled();
    expect(
      client.getQueryCache().find({
        queryKey: [
          "users",
          "user-1",
          "workspaces",
          "workspace-1",
          "projects",
          {},
        ],
        exact: true,
      }),
    ).toBeDefined();
  });

  it("does not create a tenant query until viewer bootstrap has a workspace", () => {
    const client = new QueryClient();
    const getAccessToken = () => "token-1";
    const { result } = renderHook(
      () =>
        useProjectsInfiniteQuery({
          userId: "user-1",
          workspaceId: undefined,
          getAccessToken,
        }),
      { wrapper: wrapper(client) },
    );

    expect(result.current.fetchStatus).toBe("idle");
    expect(client.getQueryCache().getAll()[0]?.queryKey).toEqual([
      "disabled",
      "projects",
    ]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("uses user-scoped viewer bootstrap and runtime tokens", async () => {
    let token = "viewer-token";
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          profile: {
            id: "user-1",
            email: "u@example.com",
            displayName: "User",
            avatarUrl: null,
          },
          workspace: {
            id: "workspace-1",
            name: "Workspace",
            type: "personal",
            ownerUserId: "user-1",
          },
          membership: {
            workspaceId: "workspace-1",
            userId: "user-1",
            role: "owner",
          },
        }),
      ),
    );

    const { result, rerender } = renderHook(
      ({ userId }: { userId: string | undefined }) =>
        useViewerQuery(userId, () => token),
      {
        wrapper: wrapper(client),
        initialProps: { userId: undefined as string | undefined },
      },
    );
    token = "rotated-token";
    rerender({ userId: "user-1" });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.workspace.id).toBe("workspace-1");
    expect(
      client.getQueryCache().find({
        queryKey: ["users", "user-1", "viewer"],
        exact: true,
      })?.queryKey,
    ).toEqual(["users", "user-1", "viewer"]);
    expect(
      new Headers(mockFetch.mock.calls[0]?.[1]?.headers).get("authorization"),
    ).toBe("Bearer rotated-token");
  });

  it("authenticates signed-in media catalogs with the execution-time token", async () => {
    let token = "catalog-token";
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    mockFetch.mockImplementation(
      async () => new Response(JSON.stringify({ models: [] })),
    );

    const { result, rerender } = renderHook(
      ({ workspaceId }: { workspaceId: string | undefined }) =>
        useImageModelsQuery(
          workspaceId
            ? {
                userId: "user-1",
                workspaceId,
                getAccessToken: () => token,
              }
            : undefined,
        ),
      {
        wrapper: wrapper(client),
        initialProps: { workspaceId: undefined as string | undefined },
      },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    mockFetch.mockClear();
    token = "latest-catalog-token";
    rerender({ workspaceId: "workspace-1" });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(
      new Headers(mockFetch.mock.calls[0]?.[1]?.headers).get("authorization"),
    ).toBe("Bearer latest-catalog-token");
  });

  it.each([
    ["image", useImageModelsQuery, "/api/image-models"],
    ["video", useVideoModelsQuery, "/api/video-models"],
  ])(
    "separates anonymous and authenticated %s catalogs and sends auth",
    async (kind, hook, path) => {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      mockFetch.mockImplementation(
        async () => new Response(JSON.stringify({ models: [] })),
      );

      const anonymous = renderHook(() => hook(), {
        wrapper: wrapper(client),
      });
      await waitFor(() =>
        expect(anonymous.result.current.isSuccess).toBe(true),
      );
      const anonymousCall = mockFetch.mock.calls[0];
      expect(anonymousCall?.[0]).toBe(`http://localhost:3001${path}`);
      expect(
        new Headers(anonymousCall?.[1]?.headers).has("authorization"),
      ).toBe(false);

      const authenticated = renderHook(
        () =>
          hook({
            userId: "user-model",
            workspaceId: "workspace-model",
            getAccessToken: () => `${kind}-token`,
          }),
        { wrapper: wrapper(client) },
      );
      await waitFor(() =>
        expect(authenticated.result.current.isSuccess).toBe(true),
      );
      const authenticatedCall = mockFetch.mock.calls[1];
      expect(
        new Headers(authenticatedCall?.[1]?.headers).get("authorization"),
      ).toBe(`Bearer ${kind}-token`);

      const keys = client
        .getQueryCache()
        .getAll()
        .map((query) => query.queryKey);
      expect(keys).toContainEqual(["public", "models", kind, {}]);
      expect(keys).toContainEqual([
        "users",
        "user-model",
        "workspaces",
        "workspace-model",
        "models",
        kind,
        {},
      ]);
    },
  );

  it("uses the public Agent models endpoint, key, and Query signal", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          models: [{ id: "agent-1", name: "Agent", provider: "openai" }],
        }),
      ),
    );

    const { result } = renderHook(useAgentModelsQuery, {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockFetch.mock.calls[0]?.[0]).toBe(
      "http://localhost:3001/api/models",
    );
    expect(mockFetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(client.getQueryCache().getAll()[0]?.queryKey).toEqual([
      "public",
      "models",
      "agent",
    ]);
  });

  it("passes an opaque cursor unchanged and reads a rotated token on next page", async () => {
    let token = "first-page-token";
    const opaqueCursor = "eyJrIjoieC8rPSJ9.signature==";
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    mockFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [], nextCursor: opaqueCursor })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [], nextCursor: null })),
      );

    const { result } = renderHook(
      () =>
        useProjectsInfiniteQuery({
          userId: "user-1",
          workspaceId: "workspace-1",
          getAccessToken: () => token,
        }),
      { wrapper: wrapper(client) },
    );
    await waitFor(() => expect(result.current.hasNextPage).toBe(true));
    token = "second-page-token";
    await result.current.fetchNextPage();
    await waitFor(() => expect(result.current.hasNextPage).toBe(false));

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const secondUrl = new URL(String(mockFetch.mock.calls[1]?.[0]));
    expect(secondUrl.searchParams.get("cursor")).toBe(opaqueCursor);
    expect(
      new Headers(mockFetch.mock.calls[1]?.[1]?.headers).get("authorization"),
    ).toBe("Bearer second-page-token");
    await result.current.fetchNextPage();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("pages chat messages forward with the exact server cursor", async () => {
    const cursor = "chat.cursor/opaque+value==";
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    mockFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [], nextCursor: cursor })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [], nextCursor: null })),
      );

    const { result } = renderHook(
      () =>
        useChatMessagesInfiniteQuery({
          userId: "user-1",
          workspaceId: "workspace-1",
          canvasId: "canvas-1",
          sessionId: "session-1",
          getAccessToken: () => "token-1",
        }),
      { wrapper: wrapper(client) },
    );
    await waitFor(() => expect(result.current.hasNextPage).toBe(true));
    await result.current.fetchNextPage();
    await waitFor(() => expect(result.current.hasNextPage).toBe(false));

    expect(
      new URL(String(mockFetch.mock.calls[1]?.[0])).searchParams.get("cursor"),
    ).toBe(cursor);
  });

  it("aborts the transport when React Query cancels an in-flight request", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    let transportSignal: AbortSignal | undefined;
    let fetchRejected = false;
    mockFetch.mockImplementation(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          transportSignal = init?.signal ?? undefined;
          init?.signal?.addEventListener(
            "abort",
            () => {
              fetchRejected = true;
              reject(new DOMException("aborted", "AbortError"));
            },
            { once: true },
          );
        }),
    );

    renderHook(
      () =>
        useProjectsInfiniteQuery({
          userId: "user-1",
          workspaceId: "workspace-1",
          getAccessToken: () => "token-1",
        }),
      { wrapper: wrapper(client) },
    );
    await waitFor(() => expect(transportSignal).toBeDefined());
    await client.cancelQueries();

    expect(transportSignal?.aborted).toBe(true);
    await waitFor(() => expect(fetchRejected).toBe(true));
    expect(client.isFetching()).toBe(0);
  });
});
