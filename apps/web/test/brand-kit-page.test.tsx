// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchDetail } = vi.hoisted(() => ({
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
  duplicateBrandKit: vi.fn(),
  updateBrandKit: vi.fn(),
  updateBrandKitAsset: vi.fn(),
  uploadBrandKitAsset: vi.fn(),
}));
vi.mock("../src/components/brand-kit/brand-kit-editor", () => ({
  BrandKitEditor: ({ kit }: { kit: { name: string } }) => (
    <div>{kit.name} editor</div>
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
});
