"use client";

import type {
  BrandKitAssetType,
  BrandKitDetail,
  BrandKitSummary,
} from "@loomic/shared";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { useAuth } from "../../lib/auth-context";
import {
  createBrandKit,
  createBrandKitAsset,
  deleteBrandKit,
  deleteBrandKitAsset,
  duplicateBrandKit,
  fetchBrandKit,
  updateBrandKit,
  updateBrandKitAsset,
  uploadBrandKitAsset,
} from "../../lib/brand-kit-api";
import { queryKeys } from "../../lib/query/keys";
import {
  useBrandKitsInfiniteQuery,
  useViewerQuery,
} from "../../lib/query/workspace-queries";
import { ApiAuthError } from "../../lib/server-api";
import { BrandKitSkeleton } from "../skeletons/brand-kit-skeleton";
import { BrandKitEditor } from "./brand-kit-editor";
import { BrandKitSidebar } from "./brand-kit-sidebar";
import { EmptyState } from "./empty-state";

export function BrandKitPage() {
  const { user, session, signOut } = useAuth();
  const queryClient = useQueryClient();
  const [selectedKit, setSelectedKit] = useState<BrandKitDetail | null>(null);

  // Use refs for values that change on token refresh but shouldn't
  // trigger callback/effect cascades (root cause of tab-switch reloads).
  const accessTokenRef = useRef(session?.access_token);
  accessTokenRef.current = session?.access_token;
  const selectedKitRef = useRef(selectedKit);
  selectedKitRef.current = selectedKit;
  const detailRequestRef = useRef(0);
  const signOutRef = useRef(signOut);
  signOutRef.current = signOut;

  const handleAuthError = useCallback(async (err: unknown) => {
    if (err instanceof ApiAuthError) {
      await signOutRef.current();
      return true;
    }
    return false;
  }, []);

  const getToken = useCallback(() => {
    const token = accessTokenRef.current;
    if (!token) throw new ApiAuthError();
    return token;
  }, []);
  const getOptionalToken = useCallback(
    () => accessTokenRef.current ?? null,
    [],
  );
  const viewer = useViewerQuery(user?.id, getOptionalToken);
  const workspaceId = viewer.data?.workspace.id;
  const catalogOwnerKey =
    user && workspaceId ? `${user.id}:${workspaceId}` : null;
  const catalogOwnerRef = useRef(catalogOwnerKey);
  catalogOwnerRef.current = catalogOwnerKey;
  const kitsQuery = useBrandKitsInfiniteQuery({
    userId: user?.id ?? "disabled",
    workspaceId,
    getAccessToken: getOptionalToken,
    limit: 20,
  });
  const kitKey =
    user && workspaceId
      ? queryKeys.workspace.brandKits(user.id, workspaceId, { limit: 20 })
      : null;
  const seenKitIds = new Set<string>();
  const kits = (kitsQuery.data?.pages ?? []).flatMap((page) =>
    page.items.filter((kit) => {
      if (seenKitIds.has(kit.id)) return false;
      seenKitIds.add(kit.id);
      return true;
    }),
  );
  const firstKitId = kits[0]?.id;

  useLayoutEffect(() => {
    detailRequestRef.current += 1;
    setSelectedKit(null);
  }, [catalogOwnerKey]);

  // --- Data loading (ref-based, no dependency cascades) ---

  const loadKitDetail = useCallback(
    async (kitId: string) => {
      const requestId = ++detailRequestRef.current;
      const initiatingOwner = catalogOwnerRef.current;
      try {
        const detail = await fetchBrandKit(getToken(), kitId);
        if (
          requestId !== detailRequestRef.current ||
          initiatingOwner !== catalogOwnerRef.current
        )
          return;
        setSelectedKit(detail);
      } catch (err) {
        if (requestId !== detailRequestRef.current) return;
        if (await handleAuthError(err)) return;
        console.error("Failed to load brand kit detail:", err);
      }
    },
    [getToken, handleAuthError],
  );

  const refreshList = useCallback(async () => {
    try {
      if (!kitKey) return [];
      await queryClient.resetQueries({ queryKey: kitKey, exact: true });
      const result = queryClient.getQueryData<{
        pages: Array<{ items: BrandKitSummary[] }>;
      }>(kitKey);
      const seen = new Set<string>();
      return (result?.pages ?? []).flatMap((page) =>
        page.items.filter((kit) => {
          if (seen.has(kit.id)) return false;
          seen.add(kit.id);
          return true;
        }),
      );
    } catch (err) {
      if (await handleAuthError(err)) return [];
      console.error("Failed to load brand kits:", err);
      return [];
    }
  }, [handleAuthError, kitKey, queryClient]);

  // Initial load — runs exactly once (workspace layout guarantees auth).
  useEffect(() => {
    if (!firstKitId || selectedKitRef.current) return;
    void loadKitDetail(firstKitId);
  }, [firstKitId, loadKitDetail]);

  // --- Kit handlers ---

  const handleSelectKit = useCallback(
    async (kitId: string) => {
      await loadKitDetail(kitId);
    },
    [loadKitDetail],
  );

  const handleCreateKit = useCallback(async () => {
    detailRequestRef.current += 1;
    const initiatingOwner = catalogOwnerRef.current;
    try {
      const newKit = await createBrandKit(getToken());
      if (initiatingOwner !== catalogOwnerRef.current) return;
      await refreshList();
      if (initiatingOwner !== catalogOwnerRef.current) return;
      setSelectedKit(newKit);
    } catch (err) {
      if (await handleAuthError(err)) return;
      console.error("Failed to create brand kit:", err);
    }
  }, [getToken, handleAuthError, refreshList]);

  const handleDuplicateKit = useCallback(async () => {
    const kit = selectedKitRef.current;
    if (!kit) return;
    detailRequestRef.current += 1;
    const initiatingOwner = catalogOwnerRef.current;
    try {
      const duplicated = await duplicateBrandKit(getToken(), kit.id);
      if (initiatingOwner !== catalogOwnerRef.current) return;
      await refreshList();
      if (initiatingOwner !== catalogOwnerRef.current) return;
      setSelectedKit(duplicated);
    } catch (err) {
      if (await handleAuthError(err)) return;
      console.error("Failed to duplicate brand kit:", err);
    }
  }, [getToken, handleAuthError, refreshList]);

  const handleUpdateKit = useCallback(
    async (data: {
      name?: string;
      guidance_text?: string | null;
      is_default?: boolean;
    }) => {
      const kit = selectedKitRef.current;
      if (!kit) return;
      detailRequestRef.current += 1;
      const initiatingOwner = catalogOwnerRef.current;
      try {
        const updated = await updateBrandKit(getToken(), kit.id, data);
        if (initiatingOwner !== catalogOwnerRef.current) return;
        setSelectedKit(updated);
        await refreshList();
      } catch (err) {
        if (await handleAuthError(err)) return;
        console.error("Failed to update brand kit:", err);
      }
    },
    [getToken, handleAuthError, refreshList],
  );

  const handleDeleteKit = useCallback(async () => {
    const kit = selectedKitRef.current;
    if (!kit) return;
    detailRequestRef.current += 1;
    const initiatingOwner = catalogOwnerRef.current;
    try {
      await deleteBrandKit(getToken(), kit.id);
      if (initiatingOwner !== catalogOwnerRef.current) return;
      const remaining = await refreshList();
      if (initiatingOwner !== catalogOwnerRef.current) return;
      const nextKit = remaining[0];
      if (nextKit) {
        await loadKitDetail(nextKit.id);
      } else {
        setSelectedKit(null);
      }
    } catch (err) {
      if (await handleAuthError(err)) return;
      console.error("Failed to delete brand kit:", err);
    }
  }, [getToken, handleAuthError, refreshList, loadKitDetail]);

  const handleDeleteKitFromSidebar = useCallback(
    async (kitId: string) => {
      detailRequestRef.current += 1;
      const initiatingOwner = catalogOwnerRef.current;
      try {
        await deleteBrandKit(getToken(), kitId);
        if (initiatingOwner !== catalogOwnerRef.current) return;
        const remaining = await refreshList();
        if (initiatingOwner !== catalogOwnerRef.current) return;
        if (selectedKitRef.current?.id === kitId) {
          const nextKit = remaining[0];
          if (nextKit) {
            await loadKitDetail(nextKit.id);
          } else {
            setSelectedKit(null);
          }
        }
      } catch (err) {
        if (await handleAuthError(err)) return;
        console.error("Failed to delete brand kit:", err);
      }
    },
    [getToken, handleAuthError, refreshList, loadKitDetail],
  );

  // --- Asset handlers ---

  const handleAddAsset = useCallback(
    async (
      type: BrandKitAssetType,
      displayName: string,
      textContent?: string | null,
      metadata?: Record<string, unknown>,
    ) => {
      const kit = selectedKitRef.current;
      if (!kit) return;
      detailRequestRef.current += 1;
      const initiatingOwner = catalogOwnerRef.current;
      try {
        await createBrandKitAsset(getToken(), kit.id, {
          asset_type: type,
          display_name: displayName,
          text_content: textContent ?? null,
          metadata,
        });
        if (initiatingOwner !== catalogOwnerRef.current) return;
        await loadKitDetail(kit.id);
      } catch (err) {
        if (await handleAuthError(err)) return;
        console.error("Failed to create asset:", err);
      }
    },
    [getToken, handleAuthError, loadKitDetail],
  );

  const handleUpdateAsset = useCallback(
    async (
      assetId: string,
      data: { display_name?: string; text_content?: string | null },
    ) => {
      const kit = selectedKitRef.current;
      if (!kit) return;
      detailRequestRef.current += 1;
      const initiatingOwner = catalogOwnerRef.current;
      try {
        await updateBrandKitAsset(getToken(), kit.id, assetId, data);
        if (initiatingOwner !== catalogOwnerRef.current) return;
        await loadKitDetail(kit.id);
      } catch (err) {
        if (await handleAuthError(err)) return;
        console.error("Failed to update asset:", err);
      }
    },
    [getToken, handleAuthError, loadKitDetail],
  );

  const handleDeleteAsset = useCallback(
    async (assetId: string) => {
      const kit = selectedKitRef.current;
      if (!kit) return;
      detailRequestRef.current += 1;
      const initiatingOwner = catalogOwnerRef.current;
      try {
        await deleteBrandKitAsset(getToken(), kit.id, assetId);
        if (initiatingOwner !== catalogOwnerRef.current) return;
        await loadKitDetail(kit.id);
        if (initiatingOwner !== catalogOwnerRef.current) return;
        await refreshList();
      } catch (err) {
        if (await handleAuthError(err)) return;
        console.error("Failed to delete asset:", err);
      }
    },
    [getToken, handleAuthError, loadKitDetail, refreshList],
  );

  const handleUploadAsset = useCallback(
    async (type: "logo" | "image", file: File) => {
      const kit = selectedKitRef.current;
      if (!kit) return;
      detailRequestRef.current += 1;
      const initiatingOwner = catalogOwnerRef.current;
      try {
        await uploadBrandKitAsset(getToken(), kit.id, type, file);
        if (initiatingOwner !== catalogOwnerRef.current) return;
        await loadKitDetail(kit.id);
        if (initiatingOwner !== catalogOwnerRef.current) return;
        await refreshList();
      } catch (err) {
        if (await handleAuthError(err)) return;
        console.error("Failed to upload asset:", err);
      }
    },
    [getToken, handleAuthError, loadKitDetail, refreshList],
  );

  // --- Render ---

  if (viewer.isPending || kitsQuery.isPending) {
    return <BrandKitSkeleton />;
  }

  if (viewer.error || kitsQuery.error) {
    return (
      <div className="flex h-[100dvh] flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <p>Unable to load brand kits.</p>
        <button
          type="button"
          className="rounded-md border px-3 py-1.5 text-foreground hover:bg-muted"
          onClick={() =>
            void (viewer.error ? viewer.refetch() : kitsQuery.refetch())
          }
        >
          Retry brand kits
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-[100dvh] w-full flex-col bg-background md:flex-row">
      {/* Sidebar: full width horizontal on mobile, vertical panel on md+ */}
      <BrandKitSidebar
        kits={kits}
        selectedKitId={selectedKit?.id ?? null}
        onSelectKit={handleSelectKit}
        onCreateKit={handleCreateKit}
        onDeleteKit={handleDeleteKitFromSidebar}
        hasMore={kitsQuery.hasNextPage}
        loadingMore={kitsQuery.isFetchingNextPage}
        onLoadMore={() => void kitsQuery.fetchNextPage()}
      />

      {selectedKit ? (
        <BrandKitEditor
          kit={selectedKit}
          onUpdateKit={handleUpdateKit}
          onDeleteKit={handleDeleteKit}
          onDuplicateKit={handleDuplicateKit}
          onAddAsset={handleAddAsset}
          onUpdateAsset={handleUpdateAsset}
          onDeleteAsset={handleDeleteAsset}
          onUploadAsset={handleUploadAsset}
        />
      ) : (
        <EmptyState onCreateKit={handleCreateKit} />
      )}
    </div>
  );
}
