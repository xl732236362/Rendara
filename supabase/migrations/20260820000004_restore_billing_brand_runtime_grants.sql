-- Credit queries run behind the authenticated server boundary with the
-- service role. Mutations remain confined to the existing security-definer
-- billing RPCs.
grant select on table public.credit_balances to service_role;
grant select on table public.subscriptions to service_role;
grant select on table public.daily_credit_claims to service_role;
grant select on table public.credit_transactions to service_role;

-- Brand kit requests use a user-scoped client. Table grants make the existing
-- owner-only RLS policies effective without broadening row visibility.
grant select, insert, update, delete on table public.brand_kits to authenticated;
grant select, insert, update, delete on table public.brand_kit_assets to authenticated;

-- Job submission and settlement remain RPC-owned. Runtime components need to
-- inspect jobs and persist the generated asset record, while user-scoped job
-- reads continue to be filtered by the existing own-job RLS policy.
grant select on table public.background_jobs to service_role;
grant select, insert on table public.asset_objects to service_role;
grant select on table public.background_jobs to authenticated;
grant select, insert, delete on table public.asset_objects to authenticated;
