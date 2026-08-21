// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { Session } from "@supabase/supabase-js";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { startTransition, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockOnAuthStateChange, mockGetSession, mockSignOut } = vi.hoisted(
  () => ({
    mockOnAuthStateChange: vi.fn(),
    mockGetSession: vi.fn(),
    mockSignOut: vi.fn(),
  }),
);

vi.mock("../src/lib/supabase-browser", () => ({
  getSupabaseBrowserClient: vi.fn(() => ({
    auth: {
      onAuthStateChange: mockOnAuthStateChange,
      getSession: mockGetSession,
      signOut: mockSignOut,
    },
  })),
}));

import { AuthProvider, useAuth } from "../src/lib/auth-context";

function TestConsumer() {
  const { user, loading } = useAuth();
  return (
    <div>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="user">{user?.email ?? "none"}</span>
    </div>
  );
}

const neverResolves = new Promise<never>(() => undefined);

function TokenCommitProbe({
  onGetter,
}: {
  onGetter: (getter: () => string | null) => void;
}) {
  const { accessToken, getAccessToken } = useAuth();

  useEffect(() => {
    onGetter(getAccessToken);
  }, [getAccessToken, onGetter]);
  if (accessToken === "token-2") throw neverResolves;

  return <span data-testid="committed-token">{accessToken}</span>;
}

describe("AuthProvider", () => {
  let authChange: (event: string, session: Session | null) => void;

  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({
      data: { session: null },
      error: null,
    });
    mockOnAuthStateChange.mockImplementation((callback) => {
      authChange = callback;
      return {
        data: { subscription: { unsubscribe: vi.fn() } },
      };
    });
  });

  it("starts in loading state then resolves to no user", async () => {
    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("false");
    });
    expect(screen.getByTestId("user").textContent).toBe("none");
  });

  it("exposes user when session exists", async () => {
    const mockSession = {
      access_token: "token_123",
      user: { id: "user_1", email: "test@test.com" },
    };
    mockGetSession.mockResolvedValue({
      data: { session: mockSession },
      error: null,
    });

    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("user").textContent).toBe("test@test.com");
    });
  });

  it("does not publish a token from an abandoned suspended render", async () => {
    const initialSession = {
      access_token: "token-1",
      user: { id: "user-1", email: "user-1@example.com" },
    } as unknown as Session;
    const suspendedSession = {
      ...initialSession,
      access_token: "token-2",
    } as Session;
    mockGetSession.mockResolvedValue({
      data: { session: initialSession },
      error: null,
    });
    let committedGetter: (() => string | null) | undefined;

    render(
      <AuthProvider>
        <TokenCommitProbe
          onGetter={(getter) => {
            committedGetter = getter;
          }}
        />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("committed-token")).toHaveTextContent(
        "token-1",
      );
    });
    expect(committedGetter?.()).toBe("token-1");

    await act(async () => {
      startTransition(() => authChange("TOKEN_REFRESHED", suspendedSession));
      await Promise.resolve();
    });

    expect(screen.getByTestId("committed-token")).toHaveTextContent("token-1");
    expect(committedGetter?.()).toBe("token-1");
  });
});
