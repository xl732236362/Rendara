// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { Session } from "@supabase/supabase-js";
import {
  type QueryClient,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { type ReactNode, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getSessionMock, onAuthStateChangeMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  onAuthStateChangeMock: vi.fn(),
}));

vi.mock("../src/lib/supabase-browser", () => ({
  getSupabaseBrowserClient: vi.fn(() => ({
    auth: {
      getSession: getSessionMock,
      onAuthStateChange: onAuthStateChangeMock,
      signOut: vi.fn(),
    },
  })),
}));

import { Providers } from "../src/components/providers";
import { AuthProvider, useAuth } from "../src/lib/auth-context";
import { createLoomicQueryClient } from "../src/lib/query/query-client";
import { IdentityQueryProvider } from "../src/lib/query/query-provider";

type AuthChange = (event: string, session: Session | null) => void;

function lastValue<T>(values: T[]): T {
  const value = values.at(-1);
  if (value === undefined) throw new Error("Expected a captured runtime value");
  return value;
}

function session(userId: string, accessToken: string): Session {
  return {
    access_token: accessToken,
    user: { id: userId, email: `${userId}@example.com` },
  } as unknown as Session;
}

function QueryRuntime({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <IdentityQueryProvider>
        <AuthReady>{children}</AuthReady>
      </IdentityQueryProvider>
    </AuthProvider>
  );
}

function AuthReady({ children }: { children: ReactNode }) {
  const { loading } = useAuth();
  return loading ? null : children;
}

function CanvasRouteProbe() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["canvas-route"],
    queryFn: async () => "query-ready",
  });

  return (
    <div>
      <span data-testid="canvas-client">
        {client ? "client-ready" : "missing-client"}
      </span>
      <span data-testid="canvas-query">{query.data ?? query.status}</span>
    </div>
  );
}

interface RuntimeSnapshot {
  client: QueryClient;
  getAccessToken: () => string | null;
}

function RuntimeProbe({
  onSnapshot,
}: {
  onSnapshot: (snapshot: RuntimeSnapshot) => void;
}) {
  const client = useQueryClient();
  const { getAccessToken } = useAuth();

  useEffect(() => {
    onSnapshot({ client, getAccessToken });
  }, [client, getAccessToken, onSnapshot]);

  return null;
}

interface AbortableDeferred<T> {
  run: (signal: AbortSignal) => Promise<T>;
  resolve: (value: T) => void;
  signal: AbortSignal | null;
}

function createAbortableDeferred<T>(): AbortableDeferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  const deferred: AbortableDeferred<T> = {
    signal: null,
    resolve: resolvePromise,
    run(signal) {
      deferred.signal = signal;
      if (signal.aborted) {
        rejectPromise(signal.reason);
      } else {
        signal.addEventListener("abort", () => rejectPromise(signal.reason), {
          once: true,
        });
      }
      return promise;
    },
  };
  return deferred;
}

function DeferredQueryProbe({
  requests,
  onClient,
}: {
  requests: AbortableDeferred<string>[];
  onClient: (client: QueryClient) => void;
}) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["identity-scoped-request"],
    queryFn: ({ signal }) => {
      const request = requests.shift();
      if (!request) throw new Error("Missing deferred query request");
      return request.run(signal);
    },
  });

  useEffect(() => {
    onClient(client);
  }, [client, onClient]);
  return (
    <span data-testid="deferred-result">{query.data ?? query.status}</span>
  );
}

describe("identity-scoped query runtime", () => {
  let authChange: AuthChange;

  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockImplementation(() => ({
        addEventListener: vi.fn(),
        addListener: vi.fn(),
        matches: false,
        removeEventListener: vi.fn(),
        removeListener: vi.fn(),
      })),
    });
    getSessionMock.mockResolvedValue({ data: { session: null }, error: null });
    onAuthStateChangeMock.mockImplementation((callback: AuthChange) => {
      authChange = callback;
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("retries only network and 5xx query failures with bounded backoff", () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.75);
    const client = createLoomicQueryClient();
    const queryDefaults = client.getDefaultOptions().queries;
    const mutationDefaults = client.getDefaultOptions().mutations;
    const retry = queryDefaults?.retry;
    const retryDelay = queryDefaults?.retryDelay;

    expect(typeof retry).toBe("function");
    expect(typeof retryDelay).toBe("function");
    if (typeof retry !== "function" || typeof retryDelay !== "function") {
      throw new Error("Expected functional query retry defaults");
    }

    expect(retry(0, new TypeError("network failed"))).toBe(true);
    expect(
      retry(1, Object.assign(new Error("unavailable"), { status: 503 })),
    ).toBe(true);
    expect(retry(2, new TypeError("network failed"))).toBe(false);
    expect(
      retry(0, Object.assign(new Error("bad request"), { status: 400 })),
    ).toBe(false);
    expect(retryDelay(1, new Error("retry"))).toBeGreaterThan(
      retryDelay(0, new Error("retry")),
    );
    expect(retryDelay(20, new Error("retry"))).toBeLessThanOrEqual(2_000);
    expect(queryDefaults?.refetchOnWindowFocus).toBe(false);
    expect(mutationDefaults?.retry).toBe(false);
    random.mockRestore();
  });

  it("provides a query client to descendants of root Providers, including /canvas", async () => {
    render(
      <Providers>
        <CanvasRouteProbe />
      </Providers>,
    );

    expect(screen.getByTestId("canvas-client")).toHaveTextContent(
      "client-ready",
    );
    await waitFor(() => {
      expect(screen.getByTestId("canvas-query")).toHaveTextContent(
        "query-ready",
      );
    });
  });

  it("preserves the query client and cache when the access token refreshes", async () => {
    getSessionMock.mockResolvedValue({
      data: { session: session("user-1", "token-1") },
      error: null,
    });
    const snapshots: RuntimeSnapshot[] = [];

    render(
      <QueryRuntime>
        <RuntimeProbe onSnapshot={(snapshot) => snapshots.push(snapshot)} />
      </QueryRuntime>,
    );

    await waitFor(() =>
      expect(snapshots.at(-1)?.getAccessToken()).toBe("token-1"),
    );
    const initial = lastValue(snapshots);
    initial.client.setQueryData(["preserved-cache"], "cached-for-user-1");

    act(() => authChange("TOKEN_REFRESHED", session("user-1", "token-2")));

    await waitFor(() =>
      expect(snapshots.at(-1)?.getAccessToken()).toBe("token-2"),
    );
    const refreshed = lastValue(snapshots);
    expect(refreshed.client).toBe(initial.client);
    expect(refreshed.getAccessToken).toBe(initial.getAccessToken);
    expect(refreshed.client.getQueryData(["preserved-cache"])).toBe(
      "cached-for-user-1",
    );
  });

  it("mounts a fresh query client when the user id changes", async () => {
    getSessionMock.mockResolvedValue({
      data: { session: session("user-1", "token-1") },
      error: null,
    });
    const snapshots: RuntimeSnapshot[] = [];

    render(
      <QueryRuntime>
        <RuntimeProbe onSnapshot={(snapshot) => snapshots.push(snapshot)} />
      </QueryRuntime>,
    );

    await waitFor(() =>
      expect(snapshots.at(-1)?.getAccessToken()).toBe("token-1"),
    );
    const firstIdentity = lastValue(snapshots);
    firstIdentity.client.setQueryData(["private-user-1"], "secret");

    act(() => authChange("SIGNED_IN", session("user-2", "token-2")));

    await waitFor(() => {
      expect(snapshots.at(-1)?.client).not.toBe(firstIdentity.client);
    });
    const secondIdentity = lastValue(snapshots);
    expect(
      secondIdentity.client.getQueryData(["private-user-1"]),
    ).toBeUndefined();
    await waitFor(() => {
      expect(
        firstIdentity.client.getQueryData(["private-user-1"]),
      ).toBeUndefined();
    });
  });

  it("aborts an old user's in-flight query without writing into the new client", async () => {
    getSessionMock.mockResolvedValue({
      data: { session: session("user-1", "token-1") },
      error: null,
    });
    const oldRequest = createAbortableDeferred<string>();
    const newRequest = createAbortableDeferred<string>();
    const clients: QueryClient[] = [];

    render(
      <QueryRuntime>
        <DeferredQueryProbe
          requests={[oldRequest, newRequest]}
          onClient={(client) => clients.push(client)}
        />
      </QueryRuntime>,
    );

    await waitFor(() => expect(oldRequest.signal).not.toBeNull());
    const oldClient = lastValue(clients);

    act(() => authChange("SIGNED_IN", session("user-2", "token-2")));

    await waitFor(() => expect(oldRequest.signal?.aborted).toBe(true));
    await waitFor(() => expect(clients.at(-1)).not.toBe(oldClient));
    const newClient = lastValue(clients);

    act(() => oldRequest.resolve("stale-user-1-result"));
    expect(newClient.getQueryData(["identity-scoped-request"])).toBeUndefined();

    act(() => newRequest.resolve("fresh-user-2-result"));
    await waitFor(() => {
      expect(screen.getByTestId("deferred-result")).toHaveTextContent(
        "fresh-user-2-result",
      );
    });
    expect(newClient.getQueryData(["identity-scoped-request"])).toBe(
      "fresh-user-2-result",
    );
  });
});
