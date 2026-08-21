"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";

import { useAuth } from "../auth-context";
import { createLoomicQueryClient } from "./query-client";

function OwnedQueryClient({
  children,
  identityKey,
}: {
  children: ReactNode;
  identityKey: string;
}) {
  const [client] = useState(createLoomicQueryClient);

  useEffect(() => {
    return () => {
      // Cancellation observes query AbortSignals synchronously; clearing then
      // makes the old identity's data unreachable even if a query ignores it.
      const cancellation = client.cancelQueries();
      client.clear();
      console.info("[query.runtime] identity_cache_disposed", { identityKey });
      void cancellation.catch((error: unknown) => {
        console.warn("[query.runtime] identity_query_cancel_failed", {
          error,
          identityKey,
        });
      });
    };
  }, [client, identityKey]);

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

export function IdentityQueryProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const identityKey = user ? `user:${user.id}` : "anonymous";

  return (
    <OwnedQueryClient key={identityKey} identityKey={identityKey}>
      {children}
    </OwnedQueryClient>
  );
}
