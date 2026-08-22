// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("../src/lib/auth-context", () => ({
  useAuth: () => ({
    user: { id: "user-1" },
    session: { access_token: "viewer-token" },
  }),
}));
vi.mock("../src/components/billing-section", () => ({
  BillingSection: () => null,
}));
vi.mock("../src/components/credits/credit-usage-history", () => ({
  CreditUsageHistory: () => null,
}));

import SettingsPage from "../src/app/(workspace)/settings/page";
import { queryKeys } from "../src/lib/query/keys";

const fetchMock = vi.fn();
globalThis.fetch = fetchMock;
const viewer = {
  profile: {
    id: "user-1",
    email: "u@example.com",
    displayName: "Viewer Name",
    avatarUrl: null,
  },
  workspace: {
    id: "workspace-viewer",
    name: "W",
    type: "personal",
    ownerUserId: "user-1",
  },
  membership: {
    workspaceId: "workspace-viewer",
    userId: "user-1",
    role: "owner",
  },
};

describe("SettingsPage", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SERVER_BASE_URL", "http://localhost:3001");
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            url.includes("/api/viewer")
              ? viewer
              : url.includes("/api/workspace/settings")
                ? { settings: { defaultModel: "agent-1" } }
                : { models: [] },
          ),
        ),
      ),
    );
  });

  it("derives the profile and workspace scope from the viewer query", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <SettingsPage />
      </QueryClientProvider>,
    );
    expect(await screen.findByDisplayValue("Viewer Name")).toBeInTheDocument();
    expect(client.getQueryData(queryKeys.viewer("user-1"))).toMatchObject({
      workspace: { id: "workspace-viewer" },
    });
  });
});
