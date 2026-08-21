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

function disposeQueryClient(client: QueryClient): Promise<void> {
  const existing = clientDisposals.get(client);
  if (existing) return existing;

  const disposal = (async () => {
    try {
      // Cancellation settles Query's internal state before clear removes its
      // GC timer. Clearing first lets cancellation schedule a timer afterward.
      await client.cancelQueries();
      client.clear();
      console.info("[query.runtime] client_disposed");
    } catch {
      // Disposal is fire-and-forget. Contain subscriber failures without
      // leaking error or identity details into logs or unhandled rejections.
      console.warn("[query.runtime] client_dispose_failed");
    }
  })();
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
