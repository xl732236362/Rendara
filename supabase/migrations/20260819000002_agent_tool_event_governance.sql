-- Govern Agent run/current-attempt state as one persisted aggregate.

alter table public.agent_runs add column current_attempt_id uuid;

alter table public.agent_run_attempts
  add constraint agent_run_attempts_run_attempt_unique
  unique (run_id, attempt_id);

-- Existing deployments are repaired only when ownership is unambiguous. A
-- remaining row aborts the migration instead of guessing from timestamps.
do $$
declare
  v_run public.agent_runs%rowtype;
  v_attempt public.agent_run_attempts%rowtype;
  v_count integer;
begin
  lock table public.agent_runs in share row exclusive mode;
  lock table public.agent_run_attempts in share row exclusive mode;

  for v_run in select * from public.agent_runs order by id loop
    select count(*) into v_count
    from public.agent_run_attempts a
    where a.run_id = v_run.id and a.status in ('accepted', 'running');

    if v_count = 1 then
      select * into v_attempt from public.agent_run_attempts a
      where a.run_id = v_run.id and a.status in ('accepted', 'running');
      if v_run.status in ('completed', 'failed', 'canceled') then
        update public.agent_run_attempts
        set status = v_run.status, completed_at = v_run.completed_at,
            lease_owner = null, lease_expires_at = null
        where attempt_id = v_attempt.attempt_id;
      else
        update public.agent_runs
        set status = v_attempt.status, completed_at = null
        where id = v_run.id;
      end if;
      update public.agent_runs set current_attempt_id = v_attempt.attempt_id
      where id = v_run.id;
      continue;
    end if;

    if v_count > 1 then
      raise exception 'agent_current_attempt_repair_ambiguous:%', v_run.id;
    end if;

    if v_run.status in ('completed', 'failed', 'canceled') then
      select count(*) into v_count from public.agent_run_attempts a
      where a.run_id = v_run.id and a.status = v_run.status
        and a.completed_at is not distinct from v_run.completed_at;
      if v_count = 1 then
        select * into v_attempt from public.agent_run_attempts a
        where a.run_id = v_run.id and a.status = v_run.status
          and a.completed_at is not distinct from v_run.completed_at;
        update public.agent_runs set current_attempt_id = v_attempt.attempt_id
        where id = v_run.id;
        continue;
      end if;

      select count(*) into v_count from public.agent_run_attempts a
      where a.run_id = v_run.id;
      if v_count = 0 then
        insert into public.agent_run_attempts(
          attempt_id, run_id, status, completed_at
        ) values (gen_random_uuid(), v_run.id, v_run.status, v_run.completed_at)
        returning * into v_attempt;
        update public.agent_runs set current_attempt_id = v_attempt.attempt_id
        where id = v_run.id;
        continue;
      end if;
    else
      select count(*) into v_count from public.agent_run_attempts a
      where a.run_id = v_run.id;
      if v_count = 1 then
        select * into v_attempt from public.agent_run_attempts a
        where a.run_id = v_run.id;
        if v_attempt.status in ('completed', 'failed', 'canceled') then
          update public.agent_runs
          set status = v_attempt.status, completed_at = v_attempt.completed_at,
              current_attempt_id = v_attempt.attempt_id
          where id = v_run.id;
          continue;
        end if;
      end if;
    end if;

    raise exception 'agent_current_attempt_repair_ambiguous:%', v_run.id;
  end loop;
end;
$$;

alter table public.agent_runs
  alter column current_attempt_id set not null,
  add constraint agent_runs_current_attempt_fk
    foreign key (id, current_attempt_id)
    references public.agent_run_attempts(run_id, attempt_id)
    deferrable initially deferred,
  add constraint agent_runs_terminal_timestamp_check check (
    (status in ('accepted', 'running') and completed_at is null)
    or (status in ('completed', 'failed', 'canceled') and completed_at is not null)
  );

alter table public.agent_run_attempts
  add constraint agent_run_attempts_terminal_timestamp_check check (
    (status in ('accepted', 'running') and completed_at is null)
    or (status in ('completed', 'failed', 'canceled') and completed_at is not null)
  );

alter table public.agent_effects
  drop constraint agent_effects_attempt_id_fkey,
  add constraint agent_effects_run_attempt_fk
    foreign key (run_id, attempt_id)
    references public.agent_run_attempts(run_id, attempt_id);

create index agent_effects_run_attempt_idx
  on public.agent_effects(run_id, attempt_id);

create or replace function public.assert_agent_terminal_alignment()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_run public.agent_runs%rowtype;
  v_attempt public.agent_run_attempts%rowtype;
  v_run_id uuid;
begin
  v_run_id := case when tg_table_name = 'agent_runs' then new.id else new.run_id end;
  select * into v_run from public.agent_runs where id = v_run_id;
  if not found then return null; end if;
  select * into v_attempt from public.agent_run_attempts
  where run_id = v_run.id and attempt_id = v_run.current_attempt_id;
  if not found
     or v_run.status <> v_attempt.status
     or v_run.completed_at is distinct from v_attempt.completed_at then
    raise exception 'agent_terminal_invariant_violation';
  end if;
  return null;
end;
$$;

create constraint trigger agent_runs_terminal_alignment
after insert or update on public.agent_runs deferrable initially deferred
for each row execute function public.assert_agent_terminal_alignment();
create constraint trigger agent_attempts_terminal_alignment
after insert or update on public.agent_run_attempts deferrable initially deferred
for each row execute function public.assert_agent_terminal_alignment();

create or replace function public.accept_agent_run(
  p_run_id uuid, p_attempt_id uuid, p_user_id uuid,
  p_client_request_id text, p_request_digest text, p_session_id uuid,
  p_thread_id text, p_model text, p_workspace_id uuid, p_project_id uuid,
  p_canvas_id uuid, p_capabilities jsonb, p_capability_policy_version text,
  p_skill_catalog_digest text, p_effective_skill_names jsonb
) returns table(run_id uuid, created boolean)
language plpgsql security definer set search_path = '' as $$
declare v_existing public.agent_runs%rowtype;
begin
  if p_canvas_id is null or p_client_request_id is null then
    raise exception 'canvas_context_required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    p_user_id::text || ':' || p_client_request_id, 0));
  select * into v_existing from public.agent_runs ar
  where ar.user_id = p_user_id and ar.client_request_id = p_client_request_id;
  if found then
    if v_existing.request_digest <> p_request_digest then
      raise exception 'agent_acceptance_conflict';
    end if;
    return query select v_existing.id, false;
    return;
  end if;
  insert into public.agent_runs(
    id, session_id, thread_id, status, model, user_id, client_request_id,
    request_digest, workspace_id, project_id, canvas_id, capabilities,
    capability_policy_version, skill_catalog_digest, effective_skill_names,
    current_attempt_id
  ) values (
    p_run_id, p_session_id, p_thread_id, 'accepted', p_model, p_user_id,
    p_client_request_id, p_request_digest, p_workspace_id, p_project_id,
    p_canvas_id, p_capabilities, p_capability_policy_version,
    p_skill_catalog_digest, p_effective_skill_names, p_attempt_id
  );
  insert into public.agent_run_attempts(attempt_id, run_id, status)
  values (p_attempt_id, p_run_id, 'accepted');
  insert into public.domain_outbox(
    aggregate_type, aggregate_id, aggregate_version, event_type, payload
  ) values ('agent_run', p_run_id, 0, 'agent.run.accepted',
    jsonb_build_object('runId', p_run_id, 'attemptId', p_attempt_id));
  return query select p_run_id, true;
end;
$$;

create or replace function public.claim_agent_attempt(
  p_attempt_id uuid, p_lease_owner text, p_lease_ms integer, p_now timestamptz
) returns table(attempt_id uuid, fencing_token bigint, lease_expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  v_run public.agent_runs%rowtype;
  v_attempt public.agent_run_attempts%rowtype;
begin
  if p_lease_ms < 1 or p_lease_owner is null or p_lease_owner = '' then
    raise exception 'attempt_lease_invalid';
  end if;
  select r.* into v_run from public.agent_runs r
  join public.agent_run_attempts a
    on a.run_id = r.id and a.attempt_id = r.current_attempt_id
  where a.attempt_id = p_attempt_id for update of r;
  if not found or v_run.status not in ('accepted', 'running') then
    raise exception 'run_not_active';
  end if;
  select * into v_attempt from public.agent_run_attempts a
  where a.run_id = v_run.id and a.attempt_id = p_attempt_id for update;
  if v_attempt.status not in ('accepted', 'running') then
    raise exception 'run_not_active';
  end if;
  if v_attempt.status = 'running' and v_attempt.lease_expires_at > p_now
     and v_attempt.lease_owner <> p_lease_owner then
    raise exception 'attempt_lease_unavailable';
  end if;
  update public.agent_runs set status = 'running' where id = v_run.id;
  update public.agent_run_attempts set status = 'running',
    lease_owner = p_lease_owner,
    lease_expires_at = p_now + make_interval(
      secs => p_lease_ms::double precision / 1000),
    fencing_token = agent_run_attempts.fencing_token + 1
  where agent_run_attempts.attempt_id = p_attempt_id
  returning agent_run_attempts.attempt_id,
    agent_run_attempts.fencing_token, agent_run_attempts.lease_expires_at
  into attempt_id, fencing_token, lease_expires_at;
  return next;
end;
$$;

create or replace function public.finalize_agent_run(
  p_run_id uuid, p_attempt_id uuid, p_fencing_token bigint,
  p_status text, p_metadata jsonb
) returns table(status text, "completedAt" timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  v_run public.agent_runs%rowtype;
  v_attempt public.agent_run_attempts%rowtype;
  v_completed_at timestamptz;
begin
  if p_status not in ('completed', 'failed', 'canceled') then
    raise exception 'agent_terminal_status_invalid';
  end if;
  if p_metadata is null or jsonb_typeof(p_metadata) <> 'object' then
    raise exception 'agent_terminal_metadata_invalid';
  end if;
  select * into v_run from public.agent_runs r
  where r.id = p_run_id for update;
  if not found then raise exception 'run_not_active'; end if;
  if v_run.current_attempt_id <> p_attempt_id then
    raise exception 'agent_attempt_not_current';
  end if;
  select * into v_attempt from public.agent_run_attempts a
  where a.run_id = p_run_id and a.attempt_id = p_attempt_id for update;
  if v_run.status in ('completed', 'failed', 'canceled') then
    if v_attempt.status <> v_run.status
       or v_attempt.completed_at is distinct from v_run.completed_at then
      raise exception 'agent_terminal_invariant_violation';
    end if;
    status := v_run.status; "completedAt" := v_run.completed_at;
    return next; return;
  end if;
  if v_attempt.status <> v_run.status
     or v_attempt.fencing_token <> p_fencing_token then
    raise exception 'run_not_active';
  end if;
  v_completed_at := clock_timestamp();
  update public.agent_runs set status = p_status,
    completed_at = v_completed_at,
    error_code = case when p_status = 'failed' then p_metadata->>'errorCode' else null end,
    error_message = case when p_status = 'failed' then p_metadata->>'errorMessage' else null end
  where id = p_run_id;
  update public.agent_run_attempts set status = p_status,
    completed_at = v_completed_at, lease_owner = null, lease_expires_at = null
  where run_id = p_run_id and attempt_id = p_attempt_id;
  status := p_status; "completedAt" := v_completed_at;
  return next;
end;
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
  v_current public.agent_run_attempts%rowtype;
  v_capabilities jsonb;
  v_skills jsonb;
begin
  select * into v_run from public.agent_runs r
  where r.id = p_run_id for update;
  if not found then raise exception 'run_not_found'; end if;
  if v_run.status not in ('accepted', 'running') then
    raise exception 'run_not_active';
  end if;
  if v_run.skill_catalog_digest <> p_active_catalog_digest then
    raise exception 'skill_catalog_changed';
  end if;
  select * into v_current from public.agent_run_attempts a
  where a.run_id = p_run_id and a.attempt_id = v_run.current_attempt_id
  for update;
  if v_current.status = 'running' and v_current.lease_expires_at > now() then
    raise exception 'attempt_lease_unavailable';
  end if;
  select coalesce(jsonb_agg(value order by value), '[]'::jsonb)
  into v_capabilities from jsonb_array_elements_text(v_run.capabilities) value
  where value in (select jsonb_array_elements_text(p_current_capabilities));
  select coalesce(jsonb_agg(value order by value), '[]'::jsonb)
  into v_skills from jsonb_array_elements_text(v_run.effective_skill_names) value
  where value in (select jsonb_array_elements_text(p_effective_skill_names));

  update public.agent_run_attempts set status = 'failed', completed_at = now(),
    lease_owner = null, lease_expires_at = null
  where agent_run_attempts.run_id = p_run_id
    and agent_run_attempts.attempt_id = v_run.current_attempt_id;
  update public.agent_runs set status = 'accepted', completed_at = null,
    current_attempt_id = p_attempt_id, capabilities = v_capabilities,
    capability_policy_version = p_capability_policy_version,
    effective_skill_names = v_skills
  where agent_runs.id = p_run_id;
  insert into public.agent_run_attempts(attempt_id, run_id, status)
  values (p_attempt_id, p_run_id, 'accepted');
  return query select p_run_id, v_run.user_id, v_run.workspace_id,
    v_run.project_id, v_run.canvas_id, v_capabilities,
    p_capability_policy_version, v_run.skill_catalog_digest, v_skills,
    p_attempt_id;
end;
$$;

drop function public.cancel_agent_attempt(uuid,bigint);

alter table public.agent_runs force row level security;
alter table public.agent_run_attempts force row level security;
alter table public.agent_effects force row level security;

revoke all on function public.assert_agent_terminal_alignment() from public;
revoke all on function public.finalize_agent_run(uuid,uuid,bigint,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.finalize_agent_run(uuid,uuid,bigint,text,jsonb)
  to service_role;
