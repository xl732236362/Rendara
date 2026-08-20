"use client";

import type { Session, User } from "@supabase/supabase-js";
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

import { getSupabaseBrowserClient } from "./supabase-browser";

interface AuthContextValue {
  user: User | null;
  session: Session | null;
  accessToken: string | null;
  authGeneration: number;
  loading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [authState, setAuthState] = useState<{
    session: Session | null;
    user: User | null;
    generation: number;
  }>({ session: null, user: null, generation: 0 });
  const [loading, setLoading] = useState(true);

  const applySession = useCallback((nextSession: Session | null) => {
    const nextUser = nextSession?.user ?? null;
    setAuthState((current) => {
      if (
        current.user?.id === nextUser?.id &&
        current.session?.access_token === nextSession?.access_token
      ) {
        return { ...current, session: nextSession, user: nextUser };
      }
      return {
        session: nextSession,
        user: nextUser,
        generation: current.generation + 1,
      };
    });
  }, []);

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();

    supabase.auth.getSession().then(({ data }) => {
      applySession(data.session);
      setLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, newSession) => {
      applySession(newSession);
      setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, [applySession]);

  async function signOut() {
    const supabase = getSupabaseBrowserClient();
    await supabase.auth.signOut();
    applySession(null);
  }

  const accessToken = authState.session?.access_token ?? null;

  return (
    <AuthContext.Provider
      value={{
        user: authState.user,
        session: authState.session,
        accessToken,
        authGeneration: authState.generation,
        loading,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}
