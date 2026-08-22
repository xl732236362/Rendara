// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fetchProjectsPage } from "../src/lib/api/projects";
import {
  useImageModelsQuery,
  useProjectsInfiniteQuery,
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
});
