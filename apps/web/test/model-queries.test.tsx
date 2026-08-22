// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { changePlan } = vi.hoisted(() => ({
  changePlan: vi.fn(async () => {}),
}));
vi.mock("../src/lib/payments-api", () => ({
  changePlan,
  cancelSubscription: vi.fn(),
  getSubscription: vi.fn(async () => ({ plan: "free" })),
}));
vi.mock("../src/lib/auth-context", () => ({
  useAuth: () => ({
    user: { id: "user-1" },
    session: { access_token: "current-token" },
  }),
}));

import { useSubscription } from "../src/hooks/use-subscription";
import { queryKeys } from "../src/lib/query/keys";

const fetchMock = vi.fn();
globalThis.fetch = fetchMock;
const viewer = {
  profile: {
    id: "user-1",
    email: "u@example.com",
    displayName: "U",
    avatarUrl: null,
  },
  workspace: {
    id: "workspace-1",
    name: "W",
    type: "personal",
    ownerUserId: "user-1",
  },
  membership: { workspaceId: "workspace-1", userId: "user-1", role: "owner" },
};

describe("authenticated model queries", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SERVER_BASE_URL", "http://localhost:3001");
    fetchMock.mockResolvedValue(new Response(JSON.stringify(viewer)));
  });

  it("invalidates only authenticated image and video catalogs after a plan change", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const imageKey = queryKeys.workspace.models.image(
      "user-1",
      "workspace-1",
      {},
    );
    const videoKey = queryKeys.workspace.models.video(
      "user-1",
      "workspace-1",
      {},
    );
    const unrelatedKey = queryKeys.workspace.projects(
      "user-1",
      "workspace-1",
      {},
    );
    client.setQueryData(imageKey, { models: [] });
    client.setQueryData(videoKey, { models: [] });
    client.setQueryData(unrelatedKey, { items: [] });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(useSubscription, { wrapper });
    await waitFor(() =>
      expect(client.getQueryData(queryKeys.viewer("user-1"))).toBeDefined(),
    );

    await act(() => result.current.changePlan("pro", "monthly"));

    expect(client.getQueryState(imageKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(videoKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(unrelatedKey)?.isInvalidated).toBe(false);
    expect(
      client
        .getQueryCache()
        .find({ queryKey: queryKeys.public.models.image({}), exact: true }),
    ).toBeUndefined();
  });
});
