"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import {
  type ReactNode,
  useCallback,
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

  useLayoutEffect(() => {
    onCommit({ client, identityKey });
  }, [client, identityKey, onCommit]);

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
    void previous.client.cancelQueries();
    previous.client.clear();
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
