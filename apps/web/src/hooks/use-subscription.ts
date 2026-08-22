// @credits-system — React hook for subscription status, cancellation, and plan changes
"use client";

import { useAuth } from "@/lib/auth-context";
import {
  type SubscriptionStatus,
  cancelSubscription as apiCancelSubscription,
  changePlan as apiChangePlan,
  getSubscription,
} from "@/lib/payments-api";
import { queryKeys } from "@/lib/query/keys";
import { useViewerQuery } from "@/lib/query/workspace-queries";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

interface UseSubscriptionReturn {
  subscription: SubscriptionStatus | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  cancel: () => Promise<void>;
  changePlan: (plan: string, billingPeriod: string) => Promise<void>;
}

export function useSubscription(): UseSubscriptionReturn {
  const { user, session } = useAuth();
  const queryClient = useQueryClient();
  const accessTokenRef = useRef(session?.access_token);
  accessTokenRef.current = session?.access_token;

  const [subscription, setSubscription] = useState<SubscriptionStatus | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const getToken = useCallback(() => accessTokenRef.current ?? null, []);
  const viewer = useViewerQuery(user?.id, getToken);

  const refresh = useCallback(async () => {
    const token = accessTokenRef.current;
    if (!token) return;
    try {
      const result = await getSubscription(token);
      setSubscription(result);
      setError(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to fetch subscription",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!session?.access_token) {
      setLoading(false);
      return;
    }
    refresh();
  }, [session?.access_token, refresh]);

  const cancel = useCallback(async () => {
    const token = accessTokenRef.current;
    if (!token) throw new Error("Not authenticated");
    await apiCancelSubscription(token);
    await refresh();
  }, [refresh]);

  const changePlan = useCallback(
    async (plan: string, billingPeriod: string) => {
      const token = accessTokenRef.current;
      if (!token) throw new Error("Not authenticated");
      await apiChangePlan(token, plan, billingPeriod);
      await refresh();
      const workspaceId = viewer.data?.workspace.id;
      if (user && workspaceId) {
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: queryKeys.workspace.models.image(
              user.id,
              workspaceId,
              {},
            ),
            exact: true,
          }),
          queryClient.invalidateQueries({
            queryKey: queryKeys.workspace.models.video(
              user.id,
              workspaceId,
              {},
            ),
            exact: true,
          }),
        ]);
        console.info("[catalog] plan_change_invalidated", {
          userId: user.id,
          workspaceId,
        });
      }
    },
    [queryClient, refresh, user, viewer.data?.workspace.id],
  );

  return { subscription, loading, error, refresh, cancel, changePlan };
}
