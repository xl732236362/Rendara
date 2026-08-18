-- Phase 3: persisted, canvas-scoped Agent acceptance and execution attempts.

alter table public.agent_runs
  add column user_id uuid references auth.users(id) on delete cascade,
  add column client_request_id text,
  add column request_digest text,
  add column workspace_id uuid references public.workspaces(id) on delete cascade,
  add column project_id uuid references public.projects(id) on delete cascade,
  add column canvas_id uuid references public.canvases(id) on delete cascade,
  add column capabilities jsonb,
  add column capability_policy_version text,
  add column skill_catalog_digest text,
  add column effective_skill_names jsonb;

alter table public.agent_runs
  add constraint agent_runs_client_request_id_length
    check (client_request_id is null or char_length(client_request_id) between 1 and 128),
  add constraint agent_runs_capabilities_array
    check (capabilities is null or jsonb_typeof(capabilities) = 'array'),
  add constraint agent_runs_effective_skill_names_array
    check (effective_skill_names is null or jsonb_typeof(effective_skill_names) = 'array');

create unique index agent_runs_user_client_request_id_idx
  on public.agent_runs(user_id, client_request_id)
  where user_id is not null and client_request_id is not null;

create table public.agent_run_attempts (
  attempt_id uuid primary key,
  run_id uuid not null references public.agent_runs(id) on delete cascade,
  status text not null check (status in ('accepted', 'running', 'completed', 'failed', 'canceled')),
  fencing_token bigint not null default 0 check (fencing_token >= 0),
  lease_owner text,
  lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint agent_run_attempts_lease_shape check (
    (lease_owner is null and lease_expires_at is null)
    or (lease_owner is not null and lease_expires_at is not null)
  )
);

create unique index agent_run_attempts_one_active_idx
  on public.agent_run_attempts(run_id)
  where status in ('accepted', 'running');

alter table public.agent_run_attempts enable row level security;
revoke all on table public.agent_run_attempts from anon, authenticated;
grant select, insert, update, delete on table public.agent_run_attempts to service_role;

create or replace function public.accept_agent_run(
  p_run_id uuid,
  p_attempt_id uuid,
  p_user_id uuid,
  p_client_request_id text,
  p_request_digest text,
  p_session_id uuid,
  p_thread_id text,
  p_model text,
  p_workspace_id uuid,
  p_project_id uuid,
  p_canvas_id uuid,
  p_capabilities jsonb,
  p_capability_policy_version text,
  p_skill_catalog_digest text,
  p_effective_skill_names jsonb
) returns table(run_id uuid, created boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.agent_runs%rowtype;
begin
  if p_canvas_id is null or p_client_request_id is null then
    raise exception 'canvas_context_required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_client_request_id, 0));
  select * into v_existing
  from public.agent_runs ar
  where ar.user_id = p_user_id
    and ar.client_request_id = p_client_request_id;

  if found then
    if v_existing.request_digest <> p_request_digest then
      raise exception 'agent_acceptance_conflict';
    end if;
    return query select v_existing.id, false;
    return;
  end if;

  insert into public.agent_runs (
    id, session_id, thread_id, status, model, user_id, client_request_id,
    request_digest, workspace_id, project_id, canvas_id, capabilities,
    capability_policy_version, skill_catalog_digest, effective_skill_names
  ) values (
    p_run_id, p_session_id, p_thread_id, 'accepted', p_model, p_user_id,
    p_client_request_id, p_request_digest, p_workspace_id, p_project_id,
    p_canvas_id, p_capabilities, p_capability_policy_version,
    p_skill_catalog_digest, p_effective_skill_names
  );

  insert into public.agent_run_attempts(attempt_id, run_id, status)
  values (p_attempt_id, p_run_id, 'accepted');

  insert into public.domain_outbox (
    aggregate_type, aggregate_id, aggregate_version, event_type, payload
  ) values (
    'agent_run', p_run_id, 0, 'agent.run.accepted',
    jsonb_build_object('runId', p_run_id, 'attemptId', p_attempt_id)
  );

  return query select p_run_id, true;
end;
$$;

revoke all on function public.accept_agent_run(
  uuid, uuid, uuid, text, text, uuid, text, text, uuid, uuid, uuid,
  jsonb, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.accept_agent_run(
  uuid, uuid, uuid, text, text, uuid, text, text, uuid, uuid, uuid,
  jsonb, text, text, jsonb
) to service_role;
