"use client";

import "@excalidraw/excalidraw/index.css";

import { AlertTriangle, RefreshCw, X } from "lucide-react";
import { useTheme } from "next-themes";
import dynamic from "next/dynamic";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useCanvasImageGeneration } from "../hooks/use-canvas-image-generation";
import type { WebSocketHandle } from "../hooks/use-websocket";
import { blobToDataURL, isVideoUrl } from "../lib/canvas-elements";
import { normalizeCanvasElements } from "../lib/canvas-normalize";
import {
  type CanvasContent,
  type DurableSceneMutation,
  createCanvasDirtySignatureFactory,
  createCanvasPersistenceCoordinator,
  createDurableSceneMutation,
  serializeCanvasFiles,
} from "../lib/canvas-persistence";
import { getServerBaseUrl } from "../lib/env";
import {
  ApiApplicationError,
  fetchCanvas,
  getAssetUrl,
  saveCanvas,
  uploadThumbnail,
} from "../lib/server-api";
import { CanvasToolMenu } from "./canvas-tool-menu";
import { VideoCanvasElement } from "./canvas/video-canvas-element";
import { ErrorBoundary } from "./error-boundary";

const Excalidraw = dynamic(
  () => import("@excalidraw/excalidraw").then((mod) => mod.Excalidraw),
  { ssr: false },
);

// Safari <16.4 does not support requestIdleCallback — provide a fallback
// that defers via setTimeout(cb, 1) to approximate idle scheduling.
const ric: typeof requestIdleCallback =
  typeof window !== "undefined" && window.requestIdleCallback
    ? window.requestIdleCallback.bind(window)
    : (cb: IdleRequestCallback) => setTimeout(cb, 1) as unknown as number;
const cic: typeof cancelIdleCallback =
  typeof window !== "undefined" && window.cancelIdleCallback
    ? window.cancelIdleCallback.bind(window)
    : clearTimeout;

// Memoize CanvasToolMenu to prevent re-renders when parent state changes
// (e.g. selection changes in the editor don't need to re-render the toolbar)
const MemoizedCanvasToolMenu = memo(CanvasToolMenu);

export type CanvasSelectedElement = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  fileId?: string;
  dataUrl?: string;
  /** Supabase storage public URL -- prefer over dataUrl for message attachments */
  storageUrl?: string;
};

type CanvasEditorProps = {
  canvasId: string;
  projectId: string;
  accessToken: string;
  userId: string;
  initialRevision: number;
  initialContent: {
    elements: Record<string, unknown>[];
    appState: Record<string, unknown>;
    files: Record<string, Record<string, unknown>>;
  };
  onApiReady?: (api: any) => void;
  onPersistenceReady?: (handle: CanvasPersistenceHandle | null) => void;
  ws?: WebSocketHandle;
  leftPanelOpen?: boolean;
  onSelectionChange?: (elements: CanvasSelectedElement[]) => void;
};

export type CanvasPersistenceHandle = {
  mutate: DurableSceneMutation;
  sync(request: { eventId: string; revision: number }): Promise<void>;
  reconcile(reason: "focus" | "reconnect" | "run_terminal"): Promise<void>;
};

const SAVE_DEBOUNCE_MS = 1500;
const THUMBNAIL_DEBOUNCE_MS = 10_000;
const THUMBNAIL_MAX_SIZE = 400;

function readDurableCanvasContent(
  api: any,
  elements: readonly any[] = api.getSceneElements(),
  appState: any = api.getAppState(),
): CanvasContent {
  return {
    elements: elements.filter((element: any) => !element.isDeleted),
    appState: {
      viewBackgroundColor: appState.viewBackgroundColor,
      gridModeEnabled: appState.gridModeEnabled,
    },
    files: serializeCanvasFiles(api.getFiles()),
  };
}

async function resolveRuntimeCanvasFiles(
  files: Record<string, Record<string, unknown>>,
  accessToken: string,
) {
  const resolved: Record<string, Record<string, unknown>> = {};
  await Promise.all(
    Object.entries(files).map(async ([fileId, file]) => {
      if (typeof file.dataURL === "string") {
        resolved[fileId] = file;
        return;
      }
      if (typeof file.assetId !== "string" || !file.assetId) return;
      const { url } = await getAssetUrl(accessToken, file.assetId);
      const response = await fetch(url);
      if (!response.ok) throw new Error("canvas_asset_fetch_failed");
      const blob = await response.blob();
      resolved[fileId] = {
        ...file,
        id: file.id ?? fileId,
        mimeType: file.mimeType ?? blob.type,
        created: file.created ?? Date.now(),
        dataURL: await blobToDataURL(blob),
      };
    }),
  );
  return resolved;
}

export function CanvasEditor({
  canvasId,
  projectId,
  accessToken,
  userId,
  initialRevision,
  initialContent,
  onApiReady,
  onPersistenceReady,
  ws,
  leftPanelOpen,
  onSelectionChange,
}: CanvasEditorProps) {
  const { resolvedTheme } = useTheme();
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const thumbnailTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const accessTokenRef = useRef(accessToken);
  accessTokenRef.current = accessToken;
  const canvasIdRef = useRef(canvasId);
  canvasIdRef.current = canvasId;
  const conflictPausedRef = useRef(false);
  const suppressNextAutosaveRef = useRef(false);
  const persistenceCoordinatorRef = useRef<ReturnType<
    typeof createCanvasPersistenceCoordinator
  > | null>(null);
  const dirtySignatureRef = useRef(createCanvasDirtySignatureFactory());
  const lastDirtySignatureRef = useRef<string | null>(null);
  const dirtyGenerationRef = useRef(0);
  const pendingDurableChangeRef = useRef(false);
  const [revisionConflict, setRevisionConflict] = useState(false);
  useEffect(() => {
    conflictPausedRef.current = false;
    persistenceCoordinatorRef.current = null;
    lastDirtySignatureRef.current = null;
    dirtyGenerationRef.current = 0;
    pendingDurableChangeRef.current = false;
    setRevisionConflict(false);
  }, [canvasId, initialRevision]);
  const [excalidrawApi, setExcalidrawApi] = useState<any>(null);
  const prevSelectedIdsRef = useRef<string>("");
  const onSelectionChangeRef = useRef(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;
  // Tracks whether the one-time normalization pass has already run
  const normalizedRef = useRef(false);

  // Guard: prevent auto-save until Excalidraw has fully hydrated with initial data.
  // Without this, a page reload can fire onChange with empty elements before
  // initialData is applied, causing a FULL REPLACE that wipes existing content.
  const hydratedRef = useRef(false);
  const initialElementCountRef = useRef(
    initialContent.elements.filter((e) => !e.isDeleted).length,
  );

  // Ref to hold initialContent.files for storageUrl lookup in handleChange
  // without adding the full initialContent to the dependency array.
  const initialFilesRef = useRef(initialContent.files);
  initialFilesRef.current = initialContent.files;

  const enqueueSave = useCallback((content: CanvasContent) => {
    const coordinator = persistenceCoordinatorRef.current;
    if (!coordinator || conflictPausedRef.current) return Promise.resolve();
    return coordinator.observe(content);
  }, []);

  // Separate inline files (ready) from storage URLs (need async fetch)
  const { inlineFiles, pendingUrls } = useMemo(() => {
    const inline: Record<string, Record<string, unknown>> = {};
    const pending: Array<{
      fileId: string;
      url?: string;
      assetId?: string;
      meta: Record<string, unknown>;
    }> = [];
    for (const [fileId, fileData] of Object.entries(initialContent.files)) {
      if (typeof fileData.assetId === "string" && fileData.assetId) {
        pending.push({ fileId, assetId: fileData.assetId, meta: fileData });
      } else if (
        typeof fileData.storageUrl === "string" &&
        fileData.storageUrl
      ) {
        pending.push({ fileId, url: fileData.storageUrl, meta: fileData });
      } else {
        inline[fileId] = fileData;
      }
    }
    return { inlineFiles: inline, pendingUrls: pending };
  }, [initialContent.files]);

  // Lazily resolve storage URLs and inject into Excalidraw
  useEffect(() => {
    if (!excalidrawApi || pendingUrls.length === 0) return;
    let cancelled = false;

    async function resolveFiles() {
      const resolved: Record<string, any> = {};
      await Promise.all(
        pendingUrls.map(async ({ fileId, url, assetId, meta }) => {
          try {
            const resolvedUrl = assetId
              ? (await getAssetUrl(accessTokenRef.current, assetId)).url
              : url;
            if (!resolvedUrl) return;
            const resp = await fetch(resolvedUrl);
            if (!resp.ok) {
              console.warn(
                `[canvas-editor] Failed to fetch file ${fileId}: ${resp.status}`,
              );
              return;
            }
            const blob = await resp.blob();
            const dataURL = await blobToDataURL(blob);
            resolved[fileId] = {
              id: meta.id ?? fileId,
              mimeType: meta.mimeType ?? blob.type,
              created: meta.created ?? Date.now(),
              dataURL,
              ...(assetId ? { assetId } : {}),
            };
          } catch (err) {
            console.warn(
              `[canvas-editor] Failed to resolve file ${fileId}:`,
              err,
            );
          }
        }),
      );
      if (!cancelled && Object.keys(resolved).length > 0) {
        excalidrawApi.addFiles(Object.values(resolved));
        console.log(
          `[canvas-editor] Resolved ${Object.keys(resolved).length} storage files`,
        );
      }
    }

    resolveFiles();
    return () => {
      cancelled = true;
    };
  }, [excalidrawApi, pendingUrls]);

  const handleExcalidrawApi = useCallback(
    (api: any) => {
      setExcalidrawApi(api);
      onApiReady?.(api);
    },
    [onApiReady],
  );

  const scheduleThumbnail = useCallback(() => {
    if (thumbnailTimerRef.current) clearTimeout(thumbnailTimerRef.current);
    thumbnailTimerRef.current = setTimeout(async () => {
      const api = excalidrawApi;
      if (!api) return;
      try {
        const { exportToBlob } = await import("@excalidraw/excalidraw");
        const sceneElements = api
          .getSceneElements()
          .filter((element: any) => !element.isDeleted);
        if (sceneElements.length === 0) return;
        const blob = await exportToBlob({
          elements: sceneElements,
          appState: { exportBackground: true },
          files: api.getFiles(),
          mimeType: "image/webp",
          quality: 0.8,
          maxWidthOrHeight: THUMBNAIL_MAX_SIZE,
        });
        await uploadThumbnail(accessTokenRef.current, projectId, blob);
        console.info("[canvas.persistence] thumbnail_committed", {
          canvasId: canvasIdRef.current,
          size: blob.size,
        });
      } catch (error) {
        console.warn("[canvas.persistence] thumbnail_failed", {
          canvasId: canvasIdRef.current,
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
      }
    }, THUMBNAIL_DEBOUNCE_MS);
  }, [excalidrawApi, projectId]);

  useEffect(() => {
    if (!excalidrawApi) return;
    const coordinator = createCanvasPersistenceCoordinator({
      initial: { revision: initialRevision, content: initialContent },
      save: async ({ expectedRevision, content }) =>
        saveCanvas(
          accessTokenRef.current,
          canvasIdRef.current,
          expectedRevision,
          content,
        ),
      fetch: async () => {
        const { canvas } = await fetchCanvas(
          accessTokenRef.current,
          canvasIdRef.current,
        );
        return {
          revision: canvas.revision,
          content: {
            elements: canvas.content.elements ?? [],
            appState: canvas.content.appState ?? {},
            files: canvas.content.files ?? {},
          },
        };
      },
      getLiveContent: () => readDurableCanvasContent(excalidrawApi),
      applyRemote: async (content) => {
        const runtimeFiles = await resolveRuntimeCanvasFiles(
          content.files,
          accessTokenRef.current,
        );
        if (Object.keys(runtimeFiles).length > 0) {
          excalidrawApi.addFiles(Object.values(runtimeFiles));
        }
        suppressNextAutosaveRef.current = true;
        excalidrawApi.updateScene({
          elements: content.elements,
          appState: content.appState,
          captureUpdate: "IMMEDIATELY",
        });
      },
      onConflict: ({ reason, baseRevision, remoteRevision }) => {
        conflictPausedRef.current = true;
        setRevisionConflict(true);
        console.warn("[canvas.persistence] synchronization_conflict", {
          canvasId: canvasIdRef.current,
          reason,
          baseRevision,
          remoteRevision,
        });
      },
      onCommitted: ({ origin, revision }) => {
        scheduleThumbnail();
        console.info("[canvas.persistence] snapshot_committed", {
          canvasId: canvasIdRef.current,
          origin,
          revision,
        });
      },
    });
    persistenceCoordinatorRef.current = coordinator;
    return () => {
      if (persistenceCoordinatorRef.current === coordinator) {
        persistenceCoordinatorRef.current = null;
      }
    };
  }, [excalidrawApi, initialContent, initialRevision, scheduleThumbnail]);

  // Normalize agent-created elements on initial load.
  // Uses DOM text measurement to fix server-side approximation errors.
  useEffect(() => {
    if (!excalidrawApi || normalizedRef.current) return;
    normalizedRef.current = true;

    // Run normalization after Excalidraw has loaded fonts.
    // Store the handle so we can cancel on unmount to prevent memory leaks.
    const idleHandle = ric(() => {
      try {
        const sceneElements = excalidrawApi.getSceneElements();
        // Create mutable copies for normalization
        const mutableElements = sceneElements.map((el: any) => ({ ...el }));
        const { changed } = normalizeCanvasElements(mutableElements);

        if (changed) {
          console.log("[canvas-editor] normalized agent-created elements");
          excalidrawApi.updateScene({
            elements: mutableElements,
            captureUpdate: "NONE",
          });
          // Persist normalized elements to DB
          const rawFiles = excalidrawApi.getFiles() as Record<string, any>;
          const files = serializeCanvasFiles(rawFiles);
          const appState = excalidrawApi.getAppState();
          enqueueSave({
            elements: mutableElements.filter((el: any) => !el.isDeleted),
            appState: {
              viewBackgroundColor: appState.viewBackgroundColor,
              gridModeEnabled: appState.gridModeEnabled,
            },
            files,
          }).catch((err: Error) =>
            console.warn("[canvas-editor] normalization save failed:", err),
          );
        }
      } catch (err) {
        console.warn("[canvas-editor] normalization failed:", err);
      }

      // Mark hydrated after normalization — auto-save is now safe.
      // Before this point, onChange may fire with incomplete element lists
      // during Excalidraw's internal initialization, which would cause a
      // FULL REPLACE with empty content and silently wipe existing data.
      hydratedRef.current = true;
    });
    return () => cic(idleHandle);
  }, [excalidrawApi, enqueueSave]);

  const handleChange = useCallback(
    (elements: readonly any[], appState: any) => {
      // Skip auto-save until Excalidraw has fully hydrated with initial data.
      // During initialization, onChange may fire with empty/partial elements
      // which would wipe the persisted canvas via FULL REPLACE.
      if (!hydratedRef.current) return;

      // Durable persistence uses a compact identity/version signature so
      // selection and viewport callbacks never serialize legacy base64 files.
      if (persistenceCoordinatorRef.current?.snapshot().stopped) {
        pendingDurableChangeRef.current = false;
      } else if (suppressNextAutosaveRef.current) {
        suppressNextAutosaveRef.current = false;
      } else {
        const signature = dirtySignatureRef.current({
          elements: elements as Record<string, unknown>[],
          appState,
          files: (excalidrawApi?.getFiles() ?? {}) as Record<
            string,
            Record<string, unknown>
          >,
        });
        if (signature !== lastDirtySignatureRef.current) {
          lastDirtySignatureRef.current = signature;
          dirtyGenerationRef.current += 1;
          pendingDurableChangeRef.current = true;
          if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
          const generation = dirtyGenerationRef.current;
          saveTimerRef.current = setTimeout(() => {
            if (!excalidrawApi) return;
            const content = readDurableCanvasContent(excalidrawApi);
            enqueueSave(content)
              .then(() => {
                if (dirtyGenerationRef.current === generation) {
                  pendingDurableChangeRef.current = false;
                }
              })
              .catch((error) => {
                console.error("[canvas.persistence] save_failed", {
                  canvasId: canvasIdRef.current,
                  ...(error instanceof ApiApplicationError
                    ? {
                        code: error.code,
                        status: error.status,
                        correlationId: error.correlationId,
                      }
                    : {
                        code: "unknown_error",
                        status: 0,
                        correlationId: undefined,
                      }),
                });
              });
          }, SAVE_DEBOUNCE_MS);
        }
      }

      // Selection remains transient UI state and is intentionally outside the
      // persistence coordinator.
      const selectedIds = appState.selectedElementIds
        ? Object.keys(appState.selectedElementIds as Record<string, boolean>)
            .filter(
              (id) =>
                (appState.selectedElementIds as Record<string, boolean>)[id],
            )
            .sort()
            .join(",")
        : "";

      if (selectedIds !== prevSelectedIdsRef.current) {
        prevSelectedIdsRef.current = selectedIds;
        if (onSelectionChangeRef.current) {
          if (!selectedIds) {
            onSelectionChangeRef.current([]);
          } else {
            const idSet = new Set(selectedIds.split(","));
            const selFiles: Record<string, any> =
              excalidrawApi?.getFiles() ?? {};
            const selected: CanvasSelectedElement[] = elements
              .filter((el: any) => idSet.has(el.id) && !el.isDeleted)
              .map((el: any) => {
                const base: CanvasSelectedElement = {
                  id: el.id,
                  type: el.type,
                  x: el.x ?? 0,
                  y: el.y ?? 0,
                  width: el.width ?? 0,
                  height: el.height ?? 0,
                };
                if (el.type === "text" && el.text) {
                  base.text = el.text;
                }
                if (el.type === "image" && el.fileId) {
                  base.fileId = el.fileId;
                  const file = selFiles[el.fileId];
                  if (file?.dataURL) {
                    base.dataUrl = file.dataURL;
                  }
                  const storageUrl =
                    el.customData?.storageUrl ??
                    initialFilesRef.current[el.fileId]?.storageUrl;
                  if (typeof storageUrl === "string" && storageUrl) {
                    base.storageUrl = storageUrl;
                  }
                }
                return base;
              });
            onSelectionChangeRef.current(selected);
          }
        }
      }
    },
    [excalidrawApi, enqueueSave],
  );

  const durableMutation = useMemo(() => {
    if (!excalidrawApi) return null;
    return createDurableSceneMutation({
      cancelPendingSave() {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        pendingDurableChangeRef.current = false;
      },
      getSceneElements: () => excalidrawApi.getSceneElements(),
      updateScene(elements) {
        suppressNextAutosaveRef.current = true;
        excalidrawApi.updateScene({
          elements,
          captureUpdate: "IMMEDIATELY",
        });
      },
      buildContent(elements) {
        const appState = excalidrawApi.getAppState();
        return {
          elements: elements.filter((element: any) => !element.isDeleted),
          appState: {
            viewBackgroundColor: appState.viewBackgroundColor,
            gridModeEnabled: appState.gridModeEnabled,
          },
          files: serializeCanvasFiles(excalidrawApi.getFiles()),
        };
      },
      enqueueSave,
      isStopped: () =>
        persistenceCoordinatorRef.current?.snapshot().stopped ?? false,
    });
  }, [enqueueSave, excalidrawApi]);

  const persistenceHandle = useMemo<CanvasPersistenceHandle | null>(() => {
    if (!durableMutation) return null;
    return {
      mutate: durableMutation,
      async sync(request) {
        await persistenceCoordinatorRef.current?.syncToRevision(
          request.revision,
        );
      },
      async reconcile(reason) {
        console.info("[canvas.persistence] reconciliation_requested", {
          canvasId: canvasIdRef.current,
          reason,
        });
        await persistenceCoordinatorRef.current?.reconcile();
      },
    };
  }, [durableMutation]);

  useEffect(() => {
    onPersistenceReady?.(persistenceHandle);
    return () => onPersistenceReady?.(null);
  }, [onPersistenceReady, persistenceHandle]);

  const { startAttempt: startImageGeneration } = useCanvasImageGeneration({
    accessToken,
    userId,
    projectId,
    canvasId,
    excalidrawApi,
    durableMutation: persistenceHandle?.mutate ?? null,
  });

  // Register screenshot RPC handler so the server can request canvas captures
  useEffect(() => {
    if (!ws || !excalidrawApi) return;

    const cleanup = ws.registerRPC("canvas.screenshot", async (params) => {
      const {
        mode,
        region,
        max_dimension = 1024,
      } = params as {
        mode: string;
        region?: { x: number; y: number; width: number; height: number };
        max_dimension?: number;
      };

      const allElements = excalidrawApi
        .getSceneElements()
        .filter((e: any) => !e.isDeleted);
      const appState = excalidrawApi.getAppState();
      const files = excalidrawApi.getFiles();

      let elements = allElements;

      if (mode === "region" && region) {
        elements = allElements.filter((el: any) => {
          const ex = (el.x as number) ?? 0;
          const ey = (el.y as number) ?? 0;
          const ew = (el.width as number) ?? 0;
          const eh = (el.height as number) ?? 0;
          return !(
            ex + ew < region.x ||
            ex > region.x + region.width ||
            ey + eh < region.y ||
            ey > region.y + region.height
          );
        });
      } else if (mode === "viewport") {
        const zoom = (appState.zoom?.value as number) ?? 1;
        const sx = -((appState.scrollX as number) ?? 0);
        const sy = -((appState.scrollY as number) ?? 0);
        const vw = ((appState.width as number) ?? 1920) / zoom;
        const vh = ((appState.height as number) ?? 1080) / zoom;
        elements = allElements.filter((el: any) => {
          const ex = (el.x as number) ?? 0;
          const ey = (el.y as number) ?? 0;
          const ew = (el.width as number) ?? 0;
          const eh = (el.height as number) ?? 0;
          return !(
            ex + ew < sx ||
            ex > sx + vw ||
            ey + eh < sy ||
            ey > sy + vh
          );
        });
      }

      const { exportToBlob } = await import("@excalidraw/excalidraw");
      const blob = await exportToBlob({
        elements,
        appState: { ...appState, exportBackground: true },
        files,
        maxWidthOrHeight: max_dimension,
        mimeType: "image/png",
      });

      // Convert blob to base64 data URL directly (no upload needed --
      // the image is passed inline to the model for visual understanding)
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () =>
          reject(new Error("Failed to convert screenshot to data URL"));
        reader.readAsDataURL(blob);
      });

      const bmp = await createImageBitmap(blob);
      const width = bmp.width;
      const height = bmp.height;
      bmp.close();

      return { url: dataUrl, width, height };
    });

    return cleanup;
  }, [ws, excalidrawApi, canvasId]);

  // Build a full save payload from current Excalidraw state.
  // Used by both beforeunload and unmount to flush pending changes.
  const buildSavePayload = useCallback(() => {
    if (!excalidrawApi) return null;
    // Never flush before hydration — Excalidraw may not have loaded elements yet
    if (!hydratedRef.current) return null;
    try {
      const sceneElements = excalidrawApi.getSceneElements();

      // Safety: refuse to save empty when we loaded with elements — prevents
      // race conditions from wiping canvas content during page teardown.
      const liveCount = sceneElements.filter((el: any) => !el.isDeleted).length;
      if (liveCount === 0 && initialElementCountRef.current > 0) {
        console.warn(
          "[canvas-editor] skipping save: 0 elements but loaded with",
          initialElementCountRef.current,
        );
        return null;
      }
      return readDurableCanvasContent(excalidrawApi, sceneElements);
    } catch (err) {
      console.warn(
        "[canvas-editor] failed to build save payload on flush:",
        err,
      );
      return null;
    }
  }, [excalidrawApi]);

  // Keep buildSavePayload accessible without stale closures
  const buildSavePayloadRef = useRef(buildSavePayload);
  buildSavePayloadRef.current = buildSavePayload;

  // Flush pending save on page close (beforeunload) and component unmount
  useEffect(() => {
    const flushBeforeUnload = () => {
      if (!pendingDurableChangeRef.current) return;
      if (persistenceCoordinatorRef.current?.snapshot().stopped) return;

      const payload = buildSavePayloadRef.current();
      if (!payload) return;

      // Use fetch with keepalive to ensure the request survives page teardown.
      // keepalive requests are limited to 64 KiB total in-flight per page; for
      // canvases with very large embedded files this may exceed the limit, but
      // it's the best-effort approach -- sendBeacon has the same constraint.
      const url = `${getServerBaseUrl()}/api/canvases/${canvasIdRef.current}`;
      try {
        fetch(url, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${accessTokenRef.current}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            expectedRevision:
              persistenceCoordinatorRef.current?.snapshot().base.revision ??
              initialRevision,
            content: payload,
          }),
          keepalive: true,
        });
      } catch {
        // Best-effort -- nothing we can do if it fails during page teardown
      }
    };

    window.addEventListener("beforeunload", flushBeforeUnload);

    return () => {
      window.removeEventListener("beforeunload", flushBeforeUnload);

      // Cancel pending debounce timers
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (thumbnailTimerRef.current) clearTimeout(thumbnailTimerRef.current);

      // Flush pending save on component unmount (e.g. SPA navigation)
      if (
        pendingDurableChangeRef.current &&
        !persistenceCoordinatorRef.current?.snapshot().stopped
      ) {
        const payload = buildSavePayloadRef.current();
        if (payload) {
          enqueueSave(payload).catch(console.error);
        }
        pendingDurableChangeRef.current = false;
      }
    };
  }, [enqueueSave, initialRevision]);

  // Render custom embeddable content for video elements on canvas.
  // Excalidraw calls this for every embeddable element; we intercept video URLs
  // and render an inline player, falling back to default for everything else.
  const renderEmbeddable = useCallback((element: any, _appState: any) => {
    const link = element?.link;
    if (typeof link === "string" && isVideoUrl(link)) {
      return (
        <VideoCanvasElement
          src={link}
          width={element.width ?? 640}
          height={element.height ?? 360}
        />
      );
    }
    // Return null to let Excalidraw handle non-video embeddables with default behavior
    return null;
  }, []);

  // Allow any URL as a valid embeddable so our video links are accepted
  const validateEmbeddable = useCallback(() => true, []);

  return (
    <ErrorBoundary
      onError={(err) => console.error("[canvas-editor] render crashed:", err)}
    >
      <div className="h-full w-full relative">
        {revisionConflict && (
          <div
            role="alert"
            className="absolute top-3 left-1/2 z-30 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-3 rounded-md border border-amber-400 bg-background px-3 py-2 text-sm shadow-md"
          >
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
            <span>
              This Canvas changed elsewhere. Reload before saving again.
            </span>
            <button
              type="button"
              className="inline-flex items-center gap-1 font-medium"
              onClick={() => window.location.reload()}
            >
              <RefreshCw className="h-4 w-4" />
              Reload
            </button>
            <button
              type="button"
              aria-label="Dismiss conflict warning"
              className="inline-flex h-7 w-7 items-center justify-center"
              onClick={() => {
                conflictPausedRef.current = false;
                setRevisionConflict(false);
              }}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
        <Excalidraw
          theme={resolvedTheme === "dark" ? "dark" : "light"}
          initialData={{
            elements: initialContent.elements as any,
            appState: initialContent.appState as any,
            files: inlineFiles as any,
          }}
          onChange={handleChange}
          excalidrawAPI={handleExcalidrawApi}
          renderEmbeddable={renderEmbeddable}
          validateEmbeddable={validateEmbeddable}
        />
        {excalidrawApi && (
          <MemoizedCanvasToolMenu
            accessToken={accessToken}
            projectId={projectId}
            startImageGeneration={startImageGeneration}
            excalidrawApi={excalidrawApi}
            leftPanelOpen={leftPanelOpen ?? false}
          />
        )}
      </div>
    </ErrorBoundary>
  );
}
