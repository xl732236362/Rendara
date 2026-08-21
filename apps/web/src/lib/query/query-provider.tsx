"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { useAuth } from "../auth-context";
import { createLoomicQueryClient } from "./query-client";

interface QueryClientOwnership {
  client: QueryClient;
  identityKey: string;
}

const clientDisposals = new WeakMap<QueryClient, Promise<void>>();
const MAX_CACHE_DISPOSAL_PASSES = 3;

interface ClientDisposalSummary {
  cancellationFailures: number;
  removalFailures: number;
  remainingMutations: number;
  remainingQueries: number;
  unexpectedFailures: number;
}

function getCacheSize(getEntries: () => readonly unknown[]): number {
  try {
    return getEntries().length;
  } catch {
    return -1;
  }
}

function logDisposalFailure(summary: ClientDisposalSummary): void {
  try {
    // Keep disposal telemetry numeric so subscriber errors and identities
    // cannot escape into logs.
    console.warn("[query.runtime] client_dispose_failed", summary);
  } catch {
    // Logging must never turn fire-and-forget disposal into a rejection.
  }
}

function disposeQueryClient(client: QueryClient): Promise<void> {
  const existing = clientDisposals.get(client);
  if (existing) return existing;

  // Deferring work ensures concurrent migration/unmount triggers observe the
  // WeakMap entry before cancellation or subscriber callbacks can run.
  const disposal = Promise.resolve().then(async () => {
    const summary: ClientDisposalSummary = {
      cancellationFailures: 0,
      removalFailures: 0,
      remainingMutations: 0,
      remainingQueries: 0,
      unexpectedFailures: 0,
    };
    let cleanupVerified = false;

    try {
      // Cancellation settles Query's internal state before removal destroys
      // its GC timer. Removing first lets cancellation schedule one afterward.
      try {
        await client.cancelQueries();
      } catch {
        summary.cancellationFailures += 1;
      }

      const queryCache = client.getQueryCache();
      const mutationCache = client.getMutationCache();

      // Subscribers may throw or repopulate a cache during notification. Work
      // from snapshots and retry a bounded number of times without letting one
      // entry prevent later query or mutation removals.
      for (let pass = 0; pass < MAX_CACHE_DISPOSAL_PASSES; pass += 1) {
        const queries = queryCache.getAll();
        const mutations = mutationCache.getAll();
        if (queries.length === 0 && mutations.length === 0) break;

        for (const query of queries) {
          try {
            queryCache.remove(query);
          } catch {
            summary.removalFailures += 1;
          }
        }

        for (const mutation of mutations) {
          try {
            mutationCache.remove(mutation);
          } catch {
            summary.removalFailures += 1;
          }
        }
      }

      summary.remainingQueries = queryCache.getAll().length;
      summary.remainingMutations = mutationCache.getAll().length;
      cleanupVerified =
        summary.remainingQueries === 0 && summary.remainingMutations === 0;
    } catch {
      summary.unexpectedFailures += 1;
      summary.remainingQueries = getCacheSize(() =>
        client.getQueryCache().getAll(),
      );
      summary.remainingMutations = getCacheSize(() =>
        client.getMutationCache().getAll(),
      );
    }

    if (!cleanupVerified) {
      // A completed but incomplete disposal must not be permanently memoized.
      clientDisposals.delete(client);
    }

    if (
      summary.cancellationFailures > 0 ||
      summary.removalFailures > 0 ||
      summary.unexpectedFailures > 0 ||
      !cleanupVerified
    ) {
      logDisposalFailure(summary);
      return;
    }

    try {
      console.info("[query.runtime] client_disposed");
    } catch {
      // Logging must never reject disposal.
    }
  });
  clientDisposals.set(client, disposal);
  return disposal;
}

function IdentityClientBoundary({
  children,
  identityKey,
  onCommit,
}: {
  children: ReactNode;
  identityKey: string;
  onCommit: (ownership: QueryClientOwnership) => void;
}) {
  const [client] = useState(createLoomicQueryClient);
  const disposalTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useLayoutEffect(() => {
    onCommit({ client, identityKey });
  }, [client, identityKey, onCommit]);

  useEffect(() => {
    if (disposalTimer.current !== null) {
      clearTimeout(disposalTimer.current);
      disposalTimer.current = null;
    }

    return () => {
      // StrictMode immediately replays setup and cancels this timer. A real
      // unmount has no replay, so ignored AbortSignals cannot retain cache.
      disposalTimer.current = setTimeout(() => {
        disposalTimer.current = null;
        void disposeQueryClient(client);
      }, 0);
    };
  }, [client]);

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

export function IdentityQueryProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const identityKey = user ? `user:${user.id}` : "anonymous";
  const committed = useRef<QueryClientOwnership | null>(null);
  const commitOwnership = useCallback((ownership: QueryClientOwnership) => {
    const previous = committed.current;
    committed.current = ownership;
    if (!previous || previous.client === ownership.client) return;

    // A committed identity migration is the only disposal authority. This
    // avoids clearing the live client during StrictMode's effect replay.
    void disposeQueryClient(previous.client);
    console.info("[query.runtime] identity_changed", {
      from: previous.identityKey,
      to: ownership.identityKey,
    });
  }, []);

  return (
    <IdentityClientBoundary
      key={identityKey}
      identityKey={identityKey}
      onCommit={commitOwnership}
    >
      {children}
    </IdentityClientBoundary>
  );
}
