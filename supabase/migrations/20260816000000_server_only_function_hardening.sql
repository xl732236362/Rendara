-- Harden server-owned RPCs and persistence bookkeeping after production lint review.
-- These functions are called through the service-role client or database triggers only.

revoke all on function public.claim_daily_credits(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.claim_daily_credits(uuid, integer)
  to service_role;

revoke all on function public.deduct_credits(uuid, uuid, integer, uuid, text)
  from public, anon, authenticated;
grant execute on function public.deduct_credits(uuid, uuid, integer, uuid, text)
  to service_role;

revoke all on function public.refund_credits(uuid, uuid, integer, uuid, text)
  from public, anon, authenticated;
grant execute on function public.refund_credits(uuid, uuid, integer, uuid, text)
  to service_role;

revoke all on function public.grant_plan_credits(uuid, public.subscription_plan, integer)
  from public, anon, authenticated;
grant execute on function public.grant_plan_credits(uuid, public.subscription_plan, integer)
  to service_role;

revoke all on function public.increment_job_attempt(uuid)
  from public, anon, authenticated;
grant execute on function public.increment_job_attempt(uuid)
  to service_role;
alter function public.increment_job_attempt(uuid) set search_path = '';

-- Trigger functions do not need direct API execution privileges.
revoke all on function public.init_workspace_credits()
  from public, anon, authenticated;
revoke all on function public.init_workspace_skills()
  from public, anon, authenticated;
revoke all on function public.update_skills_updated_at()
  from public, anon, authenticated;
alter function public.update_skills_updated_at() set search_path = '';

revoke all on function langgraph.update_updated_at_column()
  from public, anon, authenticated;
alter function langgraph.update_updated_at_column() set search_path = '';

-- agent_runs is written by the API only. RLS remains enabled as defense in depth.
revoke all on table public.agent_runs from anon, authenticated;
grant select, insert, update, delete on table public.agent_runs to service_role;

comment on table public.agent_runs is
  'Server-only run bookkeeping for LangGraph thread execution; client roles have no grants.';
