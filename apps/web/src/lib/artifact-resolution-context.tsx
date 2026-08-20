"use client";

import type { ImageArtifact } from "@loomic/shared";
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

import { ApiApplicationError } from "./api-client";
import { useAuth } from "./auth-context";
import { getAssetUrl } from "./server-api";

type ImageArtifactSource = ImageArtifact["source"];

type ArtifactResolutionContextValue = {
  authGeneration: number;
  ready: boolean;
  resolveImageUrl: (source: ImageArtifactSource) => Promise<string>;
};

type ResolutionSnapshot = {
  accessToken: string | null;
  authGeneration: number;
  viewerId: string | null;
};

const ArtifactResolutionContext = createContext<ArtifactResolutionContextValue>(
  {
    authGeneration: 0,
    ready: true,
    resolveImageUrl: (source) =>
      Promise.resolve(
        source.kind === "external"
          ? source.url
          : `/api/assets/${source.assetId}`,
      ),
  },
);

class StaleArtifactResolutionError extends Error {}

export function ArtifactResolutionProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { accessToken, authGeneration, loading, user } = useAuth();
  const inFlightRef = useRef(new Map<string, Promise<string>>());
  const controllersRef = useRef(new Set<AbortController>());
  const activeGenerationRef = useRef(authGeneration);
  const snapshotRef = useRef<ResolutionSnapshot>({
    accessToken,
    authGeneration,
    viewerId: user?.id ?? null,
  });
  snapshotRef.current = {
    accessToken,
    authGeneration,
    viewerId: user?.id ?? null,
  };

  useEffect(() => {
    if (activeGenerationRef.current !== authGeneration) {
      for (const controller of controllersRef.current) controller.abort();
      controllersRef.current.clear();
      inFlightRef.current.clear();
      activeGenerationRef.current = authGeneration;
    }
  }, [authGeneration]);

  useEffect(() => {
    return () => {
      for (const controller of controllersRef.current) controller.abort();
      controllersRef.current.clear();
      inFlightRef.current.clear();
    };
  }, []);

  const resolveAssetUrl = useCallback(async (assetId: string) => {
    const captured = snapshotRef.current;
    if (!captured.accessToken || !captured.viewerId) {
      throw new Error("artifact_resolution_requires_authentication");
    }
    const key = `${captured.viewerId}:${captured.authGeneration}:${assetId}`;
    const existing = inFlightRef.current.get(key);
    if (existing) return existing;

    const controller = new AbortController();
    controllersRef.current.add(controller);
    const request = getAssetUrl(captured.accessToken, assetId, {
      signal: controller.signal,
    })
      .then((response) => {
        const current = snapshotRef.current;
        if (
          current.viewerId !== captured.viewerId ||
          current.authGeneration !== captured.authGeneration
        ) {
          throw new StaleArtifactResolutionError();
        }
        return response.url;
      })
      .finally(() => {
        controllersRef.current.delete(controller);
        inFlightRef.current.delete(key);
      });
    inFlightRef.current.set(key, request);
    return request;
  }, []);

  const resolveImageUrl = useCallback(
    (source: ImageArtifactSource) =>
      source.kind === "external"
        ? Promise.resolve(source.url)
        : resolveAssetUrl(source.assetId),
    [resolveAssetUrl],
  );

  return (
    <ArtifactResolutionContext.Provider
      value={{ authGeneration, ready: !loading, resolveImageUrl }}
    >
      {children}
    </ArtifactResolutionContext.Provider>
  );
}

export function useArtifactImageUrl(source: ImageArtifactSource): {
  error: boolean;
  refresh: () => void;
  url: string | null;
} {
  const context = useContext(ArtifactResolutionContext);
  const [requestVersion, setRequestVersion] = useState(0);
  const [state, setState] = useState<{ error: boolean; url: string | null }>({
    error: false,
    url: source.kind === "external" ? source.url : null,
  });
  const resolutionAttempt = requestVersion + 1;

  useEffect(() => {
    let active = true;
    setState({
      error: false,
      url: source.kind === "external" ? source.url : null,
    });
    if (source.kind === "asset" && !context.ready) {
      return () => {
        active = false;
      };
    }
    void context
      .resolveImageUrl(source)
      .then((url) => {
        if (active) setState({ error: false, url });
      })
      .catch((error: unknown) => {
        if (!active || error instanceof StaleArtifactResolutionError) return;
        const errorCode =
          error instanceof ApiApplicationError
            ? error.code
            : "resolution_failed";
        console.warn("[artifact] image resolution failed", {
          assetId: source.kind === "asset" ? source.assetId : undefined,
          attempt: resolutionAttempt,
          errorCode,
        });
        setState({ error: true, url: null });
      });
    return () => {
      active = false;
    };
  }, [context, resolutionAttempt, source]);

  return {
    ...state,
    refresh: () => setRequestVersion((version) => version + 1),
  };
}

export function useArtifactUrlResolver(): ArtifactResolutionContextValue {
  const context = useContext(ArtifactResolutionContext);
  return context;
}
