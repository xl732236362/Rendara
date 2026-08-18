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

create table public.agent_skill_read_budgets (
  run_id uuid primary key references public.agent_runs(id) on delete cascade,
  distinct_reads integer not null default 0 check (distinct_reads between 0 and 16),
  returned_bytes integer not null default 0 check (returned_bytes between 0 and 262144),
  updated_at timestamptz not null default now()
);

create table public.agent_skill_reads (
  run_id uuid not null references public.agent_runs(id) on delete cascade,
  logical_read_key text not null,
  byte_count integer not null check (byte_count between 0 and 32768),
  next_cursor text,
  created_at timestamptz not null default now(),
  primary key (run_id, logical_read_key)
);

create table public.agent_skill_read_cursors (
  cursor text primary key,
  run_id uuid not null references public.agent_runs(id) on delete cascade,
  skill_name text not null,
  path text not null,
  byte_offset integer not null check (byte_offset > 0),
  created_at timestamptz not null default now()
);

create index agent_skill_read_cursors_run_idx
  on public.agent_skill_read_cursors(run_id, cursor);

alter table public.agent_skill_read_budgets enable row level security;
alter table public.agent_skill_reads enable row level security;
alter table public.agent_skill_read_cursors enable row level security;
revoke all on table public.agent_skill_read_budgets from anon, authenticated;
revoke all on table public.agent_skill_reads from anon, authenticated;
revoke all on table public.agent_skill_read_cursors from anon, authenticated;
grant select, insert, update, delete on table public.agent_skill_read_budgets to service_role;
grant select, insert, update, delete on table public.agent_skill_reads to service_role;
grant select, insert, update, delete on table public.agent_skill_read_cursors to service_role;

create or replace function public.reserve_agent_skill_read(
  p_run_id uuid,
  p_logical_read_key text,
  p_byte_count integer,
  p_next_cursor text,
  p_skill_name text,
  p_path text,
  p_next_byte_offset integer
) returns table(next_cursor text, repeated boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.agent_skill_reads%rowtype;
  v_budget public.agent_skill_read_budgets%rowtype;
begin
  select * into v_existing
  from public.agent_skill_reads r
  where r.run_id = p_run_id and r.logical_read_key = p_logical_read_key;
  if found then
    return query select v_existing.next_cursor, true;
    return;
  end if;

  insert into public.agent_skill_read_budgets(run_id)
  values (p_run_id)
  on conflict (run_id) do nothing;
  select * into v_budget
  from public.agent_skill_read_budgets b
  where b.run_id = p_run_id
  for update;

  -- A concurrent identical read may have committed while this call waited
  -- for the per-run budget lock. Recheck to keep retries idempotent.
  select * into v_existing
  from public.agent_skill_reads r
  where r.run_id = p_run_id and r.logical_read_key = p_logical_read_key;
  if found then
    return query select v_existing.next_cursor, true;
    return;
  end if;

  if v_budget.distinct_reads >= 16
     or v_budget.returned_bytes + p_byte_count > 262144 then
    raise exception 'skill_read_budget_exceeded';
  end if;

  if p_next_cursor is not null then
    if p_skill_name is null or p_path is null or p_next_byte_offset is null then
      raise exception 'skill_cursor_invalid';
    end if;
    insert into public.agent_skill_read_cursors(
      cursor, run_id, skill_name, path, byte_offset
    ) values (
      p_next_cursor, p_run_id, p_skill_name, p_path, p_next_byte_offset
    );
  end if;

  insert into public.agent_skill_reads(
    run_id, logical_read_key, byte_count, next_cursor
  ) values (
    p_run_id, p_logical_read_key, p_byte_count, p_next_cursor
  );
  update public.agent_skill_read_budgets
  set distinct_reads = distinct_reads + 1,
      returned_bytes = returned_bytes + p_byte_count,
      updated_at = now()
  where run_id = p_run_id;

  return query select p_next_cursor, false;
end;
$$;

revoke all on function public.reserve_agent_skill_read(
  uuid, text, integer, text, text, text, integer
) from public, anon, authenticated;
grant execute on function public.reserve_agent_skill_read(
  uuid, text, integer, text, text, text, integer
) to service_role;
