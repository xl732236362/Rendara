// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { duplicateKit, fetchDetail } = vi.hoisted(() => ({
  duplicateKit: vi.fn(),
  fetchDetail: vi.fn(async (_token: string, id: string) => ({
    id,
    name: id === "kit-2" ? "Launch" : "Core",
    is_default: id === "kit-1",
    guidance_text: null,
    cover_url: null,
    assets: [],
    created_at: "2026-08-22T00:00:00.000Z",
    updated_at: "2026-08-22T00:00:00.000Z",
  })),
}));
vi.mock("../src/lib/brand-kit-api", () => ({
  fetchBrandKit: fetchDetail,
  createBrandKit: vi.fn(),
  createBrandKitAsset: vi.fn(),
  deleteBrandKit: vi.fn(),
  deleteBrandKitAsset: vi.fn(),
  duplicateBrandKit: duplicateKit,
  updateBrandKit: vi.fn(),
  updateBrandKitAsset: vi.fn(),
  uploadBrandKitAsset: vi.fn(),
}));
vi.mock("../src/components/brand-kit/brand-kit-editor", () => ({
  BrandKitEditor: ({
    kit,
    onDuplicateKit,
  }: {
    kit: { name: string };
    onDuplicateKit: () => void;
  }) => (
    <div>
      {kit.name} editor
      <button type="button" onClick={onDuplicateKit}>
        Duplicate kit
      </button>
    </div>
  ),
}));
vi.mock("../src/lib/auth-context", () => ({
  useAuth: () => ({
    user: { id: "user-1" },
    session: { access_token: "token-1" },
    signOut: vi.fn(),
  }),
}));

import { BrandKitPage } from "../src/components/brand-kit/brand-kit-page";

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
const kit = (id: string, name: string) => ({
  id,
  name,
  is_default: id === "kit-1",
  cover_url: null,
  asset_counts: { color: 0, font: 0, logo: 0, image: 0 },
  created_at: "2026-08-22T00:00:00.000Z",
  updated_at: "2026-08-22T00:00:00.000Z",
});

describe("BrandKitPage", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SERVER_BASE_URL", "http://localhost:3001");
    fetchMock.mockReset();
    duplicateKit.mockReset();
    duplicateKit.mockResolvedValue({
      id: "kit-copy",
      name: "Core Copy",
      is_default: false,
      guidance_text: null,
      cover_url: null,
      assets: [],
      created_at: "2026-08-22T00:00:00.000Z",
      updated_at: "2026-08-22T00:00:00.000Z",
    });
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("/api/viewer"))
        return Promise.resolve(new Response(JSON.stringify(viewer)));
      return Promise.resolve(
        new Response(
          JSON.stringify(
            url.includes("cursor=brand-next")
              ? {
                  items: [kit("kit-1", "Core"), kit("kit-2", "Launch")],
                  nextCursor: null,
                }
              : { items: [kit("kit-1", "Core")], nextCursor: "brand-next" },
          ),
        ),
      );
    });
  });
  afterEach(cleanup);

  it("loads the next brand-kit page without duplicate IDs", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <BrandKitPage />
      </QueryClientProvider>,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Load More" }),
    );
    expect(await screen.findByText("Launch")).toBeInTheDocument();
    expect(screen.getAllByText("Core")).toHaveLength(1);
  });

  it("refreshes the brand-kit catalog exactly once after a mutation", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <BrandKitPage />
      </QueryClientProvider>,
    );
    await screen.findByText("Core editor");
    await userEvent.click(screen.getByRole("button", { name: "Load More" }));
    await screen.findByText("Launch");
    const listCallsBefore = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/api/v2/brand-kits"),
    ).length;

    await userEvent.click(
      screen.getByRole("button", { name: "Duplicate kit" }),
    );
    expect(await screen.findByText("Core Copy editor")).toBeInTheDocument();
    const listCallsAfter = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/api/v2/brand-kits"),
    ).length;
    expect(listCallsAfter - listCallsBefore).toBe(1);
  });

  it("does not let a late brand detail replace a newer selection", async () => {
    let resolveCore!: (value: Awaited<ReturnType<typeof fetchDetail>>) => void;
    fetchDetail.mockImplementation((_token: string, id: string) => {
      if (id === "kit-1") {
        return new Promise((resolve) => {
          resolveCore = resolve;
        });
      }
      return Promise.resolve({
        id,
        name: "Launch",
        is_default: false,
        guidance_text: null,
        cover_url: null,
        assets: [],
        created_at: "2026-08-22T00:00:00.000Z",
        updated_at: "2026-08-22T00:00:00.000Z",
      });
    });
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("/api/viewer"))
        return Promise.resolve(new Response(JSON.stringify(viewer)));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            items: [kit("kit-1", "Core"), kit("kit-2", "Launch")],
            nextCursor: null,
          }),
        ),
      );
    });
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <BrandKitPage />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(fetchDetail).toHaveBeenCalledWith("token-1", "kit-1"),
    );
    await userEvent.click(await screen.findByText("Launch"));
    expect(await screen.findByText("Launch editor")).toBeInTheDocument();
    await act(async () => {
      resolveCore({
        id: "kit-1",
        name: "Core",
        is_default: true,
        guidance_text: null,
        cover_url: null,
        assets: [],
        created_at: "2026-08-22T00:00:00.000Z",
        updated_at: "2026-08-22T00:00:00.000Z",
      });
    });
    expect(screen.queryByText("Core editor")).toBeNull();
  });

  it("shows a safe catalog error and retries only brand kits", async () => {
    let kitAttempts = 0;
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("/api/viewer"))
        return Promise.resolve(new Response(JSON.stringify(viewer)));
      kitAttempts += 1;
      if (kitAttempts === 1)
        return Promise.resolve(new Response("failed", { status: 500 }));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            items: [kit("kit-1", "Recovered Kit")],
            nextCursor: null,
          }),
        ),
      );
    });
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <BrandKitPage />
      </QueryClientProvider>,
    );
    expect(
      await screen.findByText("Unable to load brand kits."),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Retry brand kits" }),
    );
    expect(await screen.findByText("Recovered Kit")).toBeInTheDocument();
    expect(kitAttempts).toBe(2);
  });

  it("does not let pending detail replace a mutation-selected kit", async () => {
    let resolveLaunch!: (
      value: Awaited<ReturnType<typeof fetchDetail>>,
    ) => void;
    fetchDetail.mockImplementation((_token: string, id: string) => {
      if (id === "kit-2")
        return new Promise((resolve) => {
          resolveLaunch = resolve;
        });
      return Promise.resolve({
        id,
        name: "Core",
        is_default: true,
        guidance_text: null,
        cover_url: null,
        assets: [],
        created_at: "2026-08-22T00:00:00.000Z",
        updated_at: "2026-08-22T00:00:00.000Z",
      });
    });
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("/api/viewer"))
        return Promise.resolve(new Response(JSON.stringify(viewer)));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            items: [kit("kit-1", "Core"), kit("kit-2", "Launch")],
            nextCursor: null,
          }),
        ),
      );
    });
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <BrandKitPage />
      </QueryClientProvider>,
    );
    await screen.findByText("Core editor");
    await userEvent.click(screen.getByText("Launch"));
    await userEvent.click(
      screen.getByRole("button", { name: "Duplicate kit" }),
    );
    expect(await screen.findByText("Core Copy editor")).toBeInTheDocument();
    await act(async () => {
      resolveLaunch({
        id: "kit-2",
        name: "Launch",
        is_default: false,
        guidance_text: null,
        cover_url: null,
        assets: [],
        created_at: "2026-08-22T00:00:00.000Z",
        updated_at: "2026-08-22T00:00:00.000Z",
      });
    });
    expect(screen.queryByText("Launch editor")).toBeNull();
  });
});
