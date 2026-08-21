"use client";

import { ThemeProvider } from "next-themes";
import type { ReactNode } from "react";

import { ArtifactResolutionProvider } from "../lib/artifact-resolution-context";
import { AuthProvider } from "../lib/auth-context";
import { IdentityQueryProvider } from "../lib/query/query-provider";
import { TierLimitToastProvider } from "./credits/tier-limit-toast";
import { ToastProvider } from "./toast";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem>
      <AuthProvider>
        <IdentityQueryProvider>
          <ArtifactResolutionProvider>
            <ToastProvider>
              <TierLimitToastProvider>{children}</TierLimitToastProvider>
            </ToastProvider>
          </ArtifactResolutionProvider>
        </IdentityQueryProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}
