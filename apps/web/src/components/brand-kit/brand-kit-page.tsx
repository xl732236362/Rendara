"use client";

import type { BrandKitAssetType, BrandKitDetail } from "@loomic/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

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

  // --- Data loading (ref-based, no dependency cascades) ---

  const loadKitDetail = useCallback(
    async (kitId: string) => {
      try {
        const detail = await fetchBrandKit(getToken(), kitId);
        setSelectedKit(detail);
      } catch (err) {
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
      const result = await kitsQuery.refetch();
      const seen = new Set<string>();
      return (result.data?.pages ?? []).flatMap((page) =>
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
  }, [handleAuthError, kitKey, kitsQuery.refetch, queryClient]);

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
    try {
      const newKit = await createBrandKit(getToken());
      await refreshList();
      setSelectedKit(newKit);
    } catch (err) {
      if (await handleAuthError(err)) return;
      console.error("Failed to create brand kit:", err);
    }
  }, [getToken, handleAuthError, refreshList]);

  const handleDuplicateKit = useCallback(async () => {
    const kit = selectedKitRef.current;
    if (!kit) return;
    try {
      const duplicated = await duplicateBrandKit(getToken(), kit.id);
      await refreshList();
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
      try {
        const updated = await updateBrandKit(getToken(), kit.id, data);
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
    try {
      await deleteBrandKit(getToken(), kit.id);
      const remaining = await refreshList();
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
      try {
        await deleteBrandKit(getToken(), kitId);
        const remaining = await refreshList();
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
      try {
        await createBrandKitAsset(getToken(), kit.id, {
          asset_type: type,
          display_name: displayName,
          text_content: textContent ?? null,
          metadata,
        });
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
      try {
        await updateBrandKitAsset(getToken(), kit.id, assetId, data);
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
      try {
        await deleteBrandKitAsset(getToken(), kit.id, assetId);
        await loadKitDetail(kit.id);
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
      try {
        await uploadBrandKitAsset(getToken(), kit.id, type, file);
        await loadKitDetail(kit.id);
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
