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

alter table public.agent_runs drop constraint agent_runs_status_check;
alter table public.agent_runs add constraint agent_runs_status_check
  check (status in ('accepted', 'running', 'completed', 'failed', 'canceled'));

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

create table public.agent_effects (
  run_id uuid not null references public.agent_runs(id) on delete cascade,
  logical_tool_call_id text not null,
  attempt_id uuid not null references public.agent_run_attempts(attempt_id),
  input_digest text not null,
  status text not null check (status in ('reserved', 'completed')),
  result jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (run_id, logical_tool_call_id)
);

alter table public.agent_effects enable row level security;
revoke all on table public.agent_effects from anon, authenticated;
grant select, insert, update, delete on table public.agent_effects to service_role;

create or replace function public.claim_agent_attempt(
  p_attempt_id uuid,
  p_lease_owner text,
  p_lease_ms integer,
  p_now timestamptz
) returns table(attempt_id uuid, fencing_token bigint, lease_expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  v_attempt public.agent_run_attempts%rowtype;
begin
  if p_lease_ms < 1 or p_lease_owner is null or p_lease_owner = '' then
    raise exception 'attempt_lease_invalid';
  end if;
  select * into v_attempt from public.agent_run_attempts
  where agent_run_attempts.attempt_id = p_attempt_id for update;
  if not found or v_attempt.status not in ('accepted', 'running') then
    raise exception 'run_not_active';
  end if;
  if v_attempt.status = 'running'
     and v_attempt.lease_expires_at > p_now
     and v_attempt.lease_owner <> p_lease_owner then
    raise exception 'attempt_lease_unavailable';
  end if;
  update public.agent_run_attempts
  set status = 'running', lease_owner = p_lease_owner,
      lease_expires_at = p_now + make_interval(secs => p_lease_ms::double precision / 1000),
      fencing_token = agent_run_attempts.fencing_token + 1
  where agent_run_attempts.attempt_id = p_attempt_id
  returning agent_run_attempts.attempt_id,
            agent_run_attempts.fencing_token,
            agent_run_attempts.lease_expires_at
  into attempt_id, fencing_token, lease_expires_at;
  return next;
end;
$$;

create or replace function public.begin_agent_effect(
  p_run_id uuid, p_attempt_id uuid, p_fencing_token bigint,
  p_logical_tool_call_id text, p_input_digest text
) returns table(status text, result jsonb)
language plpgsql security definer set search_path = '' as $$
declare
  v_effect public.agent_effects%rowtype;
begin
  perform 1 from public.agent_run_attempts a
  where a.attempt_id = p_attempt_id and a.run_id = p_run_id
    and a.status = 'running' and a.fencing_token = p_fencing_token
    and a.lease_expires_at > now() for update;
  if not found then raise exception 'run_not_active'; end if;
  select * into v_effect from public.agent_effects e
  where e.run_id = p_run_id and e.logical_tool_call_id = p_logical_tool_call_id
  for update;
  if found then
    if v_effect.input_digest <> p_input_digest then
      raise exception 'agent_effect_conflict';
    end if;
    status := v_effect.status; result := v_effect.result; return next; return;
  end if;
  insert into public.agent_effects(
    run_id, logical_tool_call_id, attempt_id, input_digest, status
  ) values (p_run_id, p_logical_tool_call_id, p_attempt_id, p_input_digest, 'reserved');
  status := 'reserved'; result := null; return next;
end;
$$;

create or replace function public.complete_agent_effect(
  p_run_id uuid, p_attempt_id uuid, p_fencing_token bigint,
  p_logical_tool_call_id text, p_input_digest text, p_result jsonb
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_effect public.agent_effects%rowtype;
begin
  perform 1 from public.agent_run_attempts a
  where a.attempt_id = p_attempt_id and a.run_id = p_run_id
    and a.status = 'running' and a.fencing_token = p_fencing_token
    and a.lease_expires_at > now() for update;
  if not found then raise exception 'run_not_active'; end if;
  select * into v_effect from public.agent_effects e
  where e.run_id = p_run_id and e.logical_tool_call_id = p_logical_tool_call_id
  for update;
  if not found or v_effect.input_digest <> p_input_digest then
    raise exception 'agent_effect_conflict';
  end if;
  update public.agent_effects set status = 'completed', result = p_result,
    completed_at = coalesce(completed_at, now())
  where agent_effects.run_id = p_run_id
    and agent_effects.logical_tool_call_id = p_logical_tool_call_id;
end;
$$;

create or replace function public.commit_agent_canvas_revision(
  p_canvas_id uuid, p_actor_user_id uuid, p_expected_revision bigint,
  p_content jsonb, p_run_id uuid, p_attempt_id uuid,
  p_fencing_token bigint, p_logical_tool_call_id text,
  p_input_digest text, p_result jsonb, p_job_id uuid,
  p_effect_kind text, p_event_type text, p_event_payload jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_canvas public.canvases%rowtype;
  v_effect public.agent_effects%rowtype;
begin
  select c.* into v_canvas
  from public.agent_run_attempts a
  join public.agent_runs r on r.id = a.run_id
  join public.canvases c on c.id = r.canvas_id
  join public.projects p on p.id = c.project_id
  join public.workspace_members wm
    on wm.workspace_id = p.workspace_id
    and wm.user_id = p_actor_user_id
  where a.attempt_id = p_attempt_id
    and a.run_id = p_run_id
    and a.status = 'running'
    and a.fencing_token = p_fencing_token
    and a.lease_expires_at > now()
    and r.user_id = p_actor_user_id
    and r.canvas_id = p_canvas_id
    and r.project_id = p.id
    and r.workspace_id = p.workspace_id
  for update of a, c, wm;
  if not found then raise exception 'run_not_active'; end if;

  select * into v_effect from public.agent_effects e
  where e.run_id = p_run_id
    and e.logical_tool_call_id = p_logical_tool_call_id
  for update;
  if found then
    if v_effect.input_digest <> p_input_digest then
      raise exception 'agent_effect_conflict';
    end if;
    if v_effect.status = 'completed' then
      return jsonb_build_object(
        'revision', v_canvas.revision, 'replayed', true,
        'effectResult', v_effect.result
      );
    end if;
  else
    insert into public.agent_effects(
      run_id, logical_tool_call_id, attempt_id, input_digest, status
    ) values (
      p_run_id, p_logical_tool_call_id, p_attempt_id, p_input_digest, 'reserved'
    );
  end if;

  if p_job_id is not null and not exists (
    select 1 from public.projects p
    join public.background_jobs j
      on j.workspace_id = p.workspace_id
      and j.id = p_job_id
      and j.canvas_id = p_canvas_id
      and j.created_by = p_actor_user_id
    where p.id = v_canvas.project_id
  ) then
    raise exception using errcode = 'P0002', message = 'CANVAS_JOB_NOT_FOUND',
      detail = 'canvas_not_found';
  end if;
  if v_canvas.revision <> p_expected_revision then
    raise exception using errcode = '40001', message = 'CANVAS_REVISION_CONFLICT',
      detail = 'canvas_revision_conflict',
      hint = jsonb_build_object(
        'expectedRevision', p_expected_revision,
        'currentRevision', v_canvas.revision
      )::text;
  end if;

  update public.canvases set content = p_content, revision = revision + 1
  where id = p_canvas_id returning * into v_canvas;

  if p_job_id is not null then
    insert into public.job_effect_receipts(job_id, effect_kind, result)
    values (
      p_job_id, btrim(p_effect_kind),
      jsonb_build_object('canvasId', p_canvas_id, 'revision', v_canvas.revision)
    ) on conflict (job_id, effect_kind) do nothing;
  end if;

  insert into public.domain_outbox(
    aggregate_type, aggregate_id, aggregate_version, event_type, payload
  ) values (
    'canvas', p_canvas_id, v_canvas.revision, p_event_type,
    coalesce(p_event_payload, '{}'::jsonb) || jsonb_build_object(
      'canvasId', p_canvas_id,
      'revision', v_canvas.revision,
      'runId', p_run_id,
      'attemptId', p_attempt_id
    )
  );

  update public.agent_effects
  set status = 'completed', result = coalesce(p_result, '{}'::jsonb),
    completed_at = now()
  where run_id = p_run_id
    and logical_tool_call_id = p_logical_tool_call_id;

  return jsonb_build_object(
    'revision', v_canvas.revision, 'replayed', false,
    'effectResult', coalesce(p_result, '{}'::jsonb)
  );
end;
$$;

revoke all on function public.commit_agent_canvas_revision(
  uuid, uuid, bigint, jsonb, uuid, uuid, bigint, text, text, jsonb,
  uuid, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.commit_agent_canvas_revision(
  uuid, uuid, bigint, jsonb, uuid, uuid, bigint, text, text, jsonb,
  uuid, text, text, jsonb
) to service_role;

create or replace function public.cancel_agent_attempt(
  p_attempt_id uuid, p_fencing_token bigint
) returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.agent_run_attempts set status = 'canceled',
    fencing_token = agent_run_attempts.fencing_token + 1,
    lease_owner = null, lease_expires_at = null, completed_at = now()
  where agent_run_attempts.attempt_id = p_attempt_id
    and agent_run_attempts.status = 'running'
    and agent_run_attempts.fencing_token = p_fencing_token;
  if not found then raise exception 'run_not_active'; end if;
end;
$$;

create or replace function public.is_agent_attempt_active(
  p_attempt_id uuid, p_fencing_token bigint
) returns boolean language sql stable security definer set search_path = '' as $$
  select exists(
    select 1 from public.agent_run_attempts a
    where a.attempt_id = p_attempt_id and a.status = 'running'
      and a.fencing_token = p_fencing_token and a.lease_expires_at > now()
  );
$$;

create or replace function public.resume_agent_attempt(
  p_run_id uuid, p_attempt_id uuid, p_active_catalog_digest text,
  p_current_capabilities jsonb, p_capability_policy_version text,
  p_effective_skill_names jsonb
) returns table(
  id uuid, user_id uuid, workspace_id uuid, project_id uuid, canvas_id uuid,
  capabilities jsonb, capability_policy_version text,
  skill_catalog_digest text, effective_skill_names jsonb, attempt_id uuid
) language plpgsql security definer set search_path = '' as $$
declare
  v_run public.agent_runs%rowtype;
  v_capabilities jsonb;
  v_skills jsonb;
begin
  select * into v_run from public.agent_runs r where r.id = p_run_id for update;
  if not found then raise exception 'run_not_found'; end if;
  if v_run.skill_catalog_digest <> p_active_catalog_digest then
    raise exception 'skill_catalog_changed';
  end if;
  select coalesce(jsonb_agg(value order by value), '[]'::jsonb) into v_capabilities
  from jsonb_array_elements_text(v_run.capabilities) value
  where value in (select jsonb_array_elements_text(p_current_capabilities));
  select coalesce(jsonb_agg(value order by value), '[]'::jsonb) into v_skills
  from jsonb_array_elements_text(v_run.effective_skill_names) value
  where value in (select jsonb_array_elements_text(p_effective_skill_names));
  update public.agent_run_attempts set status = 'failed', completed_at = now(),
    lease_owner = null, lease_expires_at = null
  where run_id = p_run_id and status in ('accepted', 'running');
  update public.agent_runs set capabilities = v_capabilities,
    capability_policy_version = p_capability_policy_version,
    effective_skill_names = v_skills where agent_runs.id = p_run_id;
  insert into public.agent_run_attempts(attempt_id, run_id, status)
  values (p_attempt_id, p_run_id, 'accepted');
  return query select p_run_id, v_run.user_id, v_run.workspace_id,
    v_run.project_id, v_run.canvas_id, v_capabilities,
    p_capability_policy_version, v_run.skill_catalog_digest, v_skills, p_attempt_id;
end;
$$;

revoke all on function public.claim_agent_attempt(uuid,text,integer,timestamptz) from public, anon, authenticated;
revoke all on function public.begin_agent_effect(uuid,uuid,bigint,text,text) from public, anon, authenticated;
revoke all on function public.complete_agent_effect(uuid,uuid,bigint,text,text,jsonb) from public, anon, authenticated;
revoke all on function public.cancel_agent_attempt(uuid,bigint) from public, anon, authenticated;
revoke all on function public.is_agent_attempt_active(uuid,bigint) from public, anon, authenticated;
revoke all on function public.resume_agent_attempt(uuid,uuid,text,jsonb,text,jsonb) from public, anon, authenticated;
grant execute on function public.claim_agent_attempt(uuid,text,integer,timestamptz) to service_role;
grant execute on function public.begin_agent_effect(uuid,uuid,bigint,text,text) to service_role;
grant execute on function public.complete_agent_effect(uuid,uuid,bigint,text,text,jsonb) to service_role;
grant execute on function public.cancel_agent_attempt(uuid,bigint) to service_role;
grant execute on function public.is_agent_attempt_active(uuid,bigint) to service_role;
grant execute on function public.resume_agent_attempt(uuid,uuid,text,jsonb,text,jsonb) to service_role;
