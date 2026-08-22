// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CreditUsageHistory } from "../src/components/credits/credit-usage-history";

vi.mock("../src/lib/auth-context", () => ({
  useAuth: () => ({
    user: { id: "user-1" },
    session: { access_token: "token-1" },
  }),
}));

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
const transaction = (id: string, description: string) => ({
  id,
  amount: -1,
  balance_after: 9,
  transaction_type: "generation_deduct",
  description,
  job_id: null,
  created_at: "2026-08-22T00:00:00.000Z",
});

describe("CreditUsageHistory", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SERVER_BASE_URL", "http://localhost:3001");
    fetchMock.mockReset();
  });
  afterEach(cleanup);

  it("loads cursor pages without duplicate transaction IDs", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("/api/viewer")) {
        return Promise.resolve(new Response(JSON.stringify(viewer)));
      }
      const second = url.includes("cursor=credits-next");
      return Promise.resolve(
        new Response(
          JSON.stringify(
            second
              ? {
                  items: [
                    transaction(
                      "11111111-1111-4111-8111-111111111111",
                      "First",
                    ),
                    transaction(
                      "22222222-2222-4222-8222-222222222222",
                      "Second",
                    ),
                  ],
                  nextCursor: null,
                }
              : {
                  items: [
                    transaction(
                      "11111111-1111-4111-8111-111111111111",
                      "First",
                    ),
                  ],
                  nextCursor: "credits-next",
                },
          ),
        ),
      );
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <CreditUsageHistory />
      </QueryClientProvider>,
    );

    await userEvent.click(
      await screen.findByRole("button", { name: "Load More" }),
    );
    expect(await screen.findByText("Second")).toBeInTheDocument();
    expect(screen.getAllByText("First")).toHaveLength(1);
  });
});
