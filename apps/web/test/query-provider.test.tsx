// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { Session } from "@supabase/supabase-js";
import {
  type QueryClient,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { type ReactNode, StrictMode, useEffect } from "react";
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
import { ApiApplicationError, ApiNetworkError } from "../src/lib/api-client";
import { AuthProvider, useAuth } from "../src/lib/auth-context";
import { createLoomicQueryClient } from "../src/lib/query/query-client";
import { IdentityQueryProvider } from "../src/lib/query/query-provider";

type AuthChange = (event: string, session: Session | null) => void;

function lastValue<T>(values: T[]): T {
  const value = values.at(-1);
  if (value === undefined) throw new Error("Expected a captured runtime value");
  return value;
}

async function flushDisposalWindow(): Promise<void> {
  if (vi.isFakeTimers()) {
    await vi.advanceTimersByTimeAsync(0);
  } else {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  await Promise.resolve();
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

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
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

function StrictModeQueryProbe({
  queryFn,
  onClient,
}: {
  queryFn: () => Promise<string>;
  onClient: (client: QueryClient) => void;
}) {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["strict-mode-cache"], queryFn });

  useEffect(() => {
    onClient(client);
  }, [client, onClient]);

  return <span data-testid="strict-result">{query.data ?? query.status}</span>;
}

function SignalIgnoringQueryProbe({
  requests,
  onClient,
}: {
  requests: Deferred<string>[];
  onClient: (client: QueryClient) => void;
}) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["signal-ignoring-request"],
    queryFn: () => {
      const request = requests.shift();
      if (!request) throw new Error("Missing deferred query request");
      return request.promise;
    },
  });

  useEffect(() => {
    onClient(client);
  }, [client, onClient]);

  return (
    <span data-testid="signal-ignoring-result">
      {query.data ?? query.status}
    </span>
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

  afterEach(async () => {
    cleanup();
    await flushDisposalWindow();
    vi.useRealTimers();
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

    expect(retry(0, new ApiNetworkError())).toBe(true);
    expect(
      retry(
        1,
        new ApiApplicationError("unavailable", "Unavailable", { status: 503 }),
      ),
    ).toBe(true);
    expect(retry(2, new ApiNetworkError())).toBe(false);
    expect(retry(0, new TypeError("query implementation bug"))).toBe(false);
    expect(
      retry(0, Object.assign(new Error("fake status"), { status: 503 })),
    ).toBe(false);
    expect(
      retry(
        0,
        new ApiApplicationError("bad_request", "Bad request", { status: 400 }),
      ),
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

  it("keeps the committed identity client intact during StrictMode effect replay", async () => {
    getSessionMock.mockResolvedValue({
      data: { session: session("user-1", "token-1") },
      error: null,
    });
    const queryFn = vi.fn(async () => "strict-mode-result");
    const clients: QueryClient[] = [];

    render(
      <StrictMode>
        <QueryRuntime>
          <StrictModeQueryProbe
            queryFn={queryFn}
            onClient={(client) => clients.push(client)}
          />
        </QueryRuntime>
      </StrictMode>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("strict-result")).toHaveTextContent(
        "strict-mode-result",
      );
    });
    const client = lastValue(clients);
    expect(queryFn).toHaveBeenCalledOnce();
    expect(client.getQueryData(["strict-mode-cache"])).toBe(
      "strict-mode-result",
    );
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

  it("drops a late old-identity result even when its query ignores AbortSignal", async () => {
    getSessionMock.mockResolvedValue({
      data: { session: session("user-1", "token-1") },
      error: null,
    });
    const oldRequest = createDeferred<string>();
    const newRequest = createDeferred<string>();
    const requests = [oldRequest, newRequest];
    const clients: QueryClient[] = [];

    render(
      <QueryRuntime>
        <SignalIgnoringQueryProbe
          requests={requests}
          onClient={(client) => clients.push(client)}
        />
      </QueryRuntime>,
    );

    await waitFor(() => expect(requests).toHaveLength(1));
    const oldClient = lastValue(clients);

    act(() => authChange("SIGNED_IN", session("user-2", "token-2")));

    await waitFor(() => expect(requests).toHaveLength(0));
    const newClient = lastValue(clients);
    expect(newClient).not.toBe(oldClient);

    await act(async () => {
      oldRequest.resolve("stale-user-1-result");
      await Promise.resolve();
    });

    expect(oldClient.getQueryData(["signal-ignoring-request"])).toBeUndefined();
    expect(newClient.getQueryData(["signal-ignoring-request"])).toBeUndefined();

    act(() => newRequest.resolve("fresh-user-2-result"));
    await waitFor(() => {
      expect(screen.getByTestId("signal-ignoring-result")).toHaveTextContent(
        "fresh-user-2-result",
      );
    });
  });

  it("disposes an identity client only once when migration and unmount overlap", async () => {
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
    const oldClient = lastValue(snapshots).client;
    oldClient.setQueryData(["idempotent-disposal"], "cached");
    const cancelQueries = vi.spyOn(oldClient, "cancelQueries");
    const removeQuery = vi.spyOn(oldClient.getQueryCache(), "remove");
    vi.useFakeTimers();

    act(() => authChange("SIGNED_IN", session("user-2", "token-2")));
    expect(lastValue(snapshots).client).not.toBe(oldClient);
    await act(async () => {
      await flushDisposalWindow();
    });

    expect(cancelQueries).toHaveBeenCalledOnce();
    expect(removeQuery).toHaveBeenCalledOnce();
    expect(oldClient.getQueryCache().findAll()).toHaveLength(0);
  });

  it("contains subscriber failures during disposal without leaking details", async () => {
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
    const oldClient = lastValue(snapshots).client;
    oldClient.setQueryData(["throwing-subscriber-1"], "cached-1");
    oldClient.setQueryData(["throwing-subscriber-2"], "cached-2");
    oldClient.getMutationCache().build(oldClient, {
      mutationKey: ["private-mutation"],
      mutationFn: async () => "unused",
    });
    oldClient.getQueryCache().subscribe(() => {
      throw new Error("private subscriber details");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.useFakeTimers();

    act(() => authChange("SIGNED_IN", session("user-2", "token-2")));
    expect(lastValue(snapshots).client).not.toBe(oldClient);
    await act(async () => {
      await flushDisposalWindow();
    });

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "[query.runtime] client_dispose_failed",
      expect.objectContaining({
        removalFailures: 2,
        remainingMutations: 0,
        remainingQueries: 0,
      }),
    );
    expect(oldClient.getQueryCache().findAll()).toHaveLength(0);
    expect(oldClient.getMutationCache().getAll()).toHaveLength(0);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(
      "private subscriber details",
    );
  });

  it("retries disposal when a bounded cleanup leaves cache entries", async () => {
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
    const oldClient = lastValue(snapshots).client;
    oldClient.setQueryData(["retryable-disposal"], "cached");
    const queryCache = oldClient.getQueryCache();
    const removeQuery = queryCache.remove.bind(queryCache);
    let allowRemoval = false;
    vi.spyOn(queryCache, "remove").mockImplementation((query) => {
      if (!allowRemoval) throw new Error("transient removal failure");
      removeQuery(query);
    });
    const cancelQueries = vi.spyOn(oldClient, "cancelQueries");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.useFakeTimers();

    act(() => authChange("SIGNED_IN", session("user-2", "token-2")));
    await act(async () => {
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
    });
    expect(oldClient.getQueryCache().findAll()).toHaveLength(1);

    allowRemoval = true;
    await act(async () => {
      await flushDisposalWindow();
    });

    expect(cancelQueries).toHaveBeenCalledTimes(2);
    expect(oldClient.getQueryCache().findAll()).toHaveLength(0);
  });

  it("disposes a signal-ignoring query after the root provider unmounts", async () => {
    getSessionMock.mockResolvedValue({
      data: { session: session("user-1", "token-1") },
      error: null,
    });
    const request = createDeferred<string>();
    const requests = [request];
    const clients: QueryClient[] = [];
    const root = render(
      <QueryRuntime>
        <SignalIgnoringQueryProbe
          requests={requests}
          onClient={(client) => clients.push(client)}
        />
      </QueryRuntime>,
    );

    await waitFor(() => expect(requests).toHaveLength(0));
    const client = lastValue(clients);
    expect(client.getQueryCache().findAll()).toHaveLength(1);

    vi.useFakeTimers();
    root.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(client.getQueryCache().findAll()).toHaveLength(0);
    expect(client.getQueryData(["signal-ignoring-request"])).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);

    await act(async () => {
      request.resolve("late-unmounted-result");
      await Promise.resolve();
    });

    expect(client.getQueryCache().findAll()).toHaveLength(0);
    expect(client.getQueryData(["signal-ignoring-request"])).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});
