-- Phase 2 independent-review hardening.
-- External providers are not transaction participants. Persist intent before
-- invoking them and refuse ambiguous replay instead of claiming atomicity.

create table if not exists public.generation_effect_attempts (
  job_id uuid primary key references public.background_jobs (id) on delete cascade,
  lease_token uuid not null,
  state text not null check (state in ('started', 'completed', 'ambiguous')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  result jsonb
);

alter table public.generation_effect_attempts enable row level security;
revoke all on table public.generation_effect_attempts from public, anon, authenticated;
grant all on table public.generation_effect_attempts to service_role;

alter table public.asset_objects
  add column if not exists generation_job_id uuid
  references public.background_jobs (id) on delete set null;
create unique index if not exists asset_objects_generation_job_id_key
  on public.asset_objects (generation_job_id)
  where generation_job_id is not null;

create or replace function public.begin_generation_effect(
  p_job_id uuid,
  p_lease_token uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.background_jobs%rowtype;
  v_attempt public.generation_effect_attempts%rowtype;
begin
  select * into v_job from public.background_jobs where id = p_job_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'JOB_NOT_FOUND', detail = 'job_not_found';
  end if;
  if v_job.lease_token is distinct from p_lease_token
     or v_job.status not in ('running', 'cancel_requested')
     or v_job.lease_expires_at <= now() then
    raise exception using errcode = 'P0001', message = 'STALE_JOB_LEASE', detail = 'stale_job_lease';
  end if;

  select * into v_attempt
  from public.generation_effect_attempts
  where job_id = p_job_id
  for update;

  if found then
    if v_attempt.state = 'completed' then
      return jsonb_build_object('kind', 'completed', 'result', v_attempt.result);
    end if;
    if v_attempt.state = 'started' and v_attempt.lease_token = p_lease_token then
      return jsonb_build_object('kind', 'started', 'replayed', true);
    end if;
    return jsonb_build_object('kind', 'ambiguous');
  end if;

  insert into public.generation_effect_attempts (job_id, lease_token, state)
  values (p_job_id, p_lease_token, 'started');
  return jsonb_build_object('kind', 'started', 'replayed', false);
end;
$$;

create or replace function public.claim_generation_job(
  p_job_id uuid,
  p_lease_owner text,
  p_lease_seconds integer
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.background_jobs%rowtype;
  v_token uuid := gen_random_uuid();
  v_has_effect boolean;
begin
  if char_length(btrim(p_lease_owner)) not between 1 and 100
     or p_lease_seconds not between 5 and 3600 then
    raise exception using errcode = '22023', message = 'INVALID_LEASE', detail = 'invalid_request';
  end if;
  select * into v_job from public.background_jobs where id = p_job_id for update;
  if not found then return jsonb_build_object('kind', 'missing'); end if;
  if v_job.status in ('succeeded', 'canceled', 'dead_letter') then
    return jsonb_build_object('kind', 'terminal', 'job', to_jsonb(v_job));
  end if;
  if v_job.status in ('running', 'cancel_requested') and v_job.lease_expires_at > now() then
    return jsonb_build_object('kind', 'busy', 'job', to_jsonb(v_job));
  end if;
  if v_job.status = 'cancel_requested' then
    select exists(
      select 1 from public.generation_effect_attempts
      where job_id = p_job_id and state in ('started', 'ambiguous', 'completed')
    ) into v_has_effect;
    update public.background_jobs
    set status = case
          when v_has_effect then 'dead_letter'::public.background_job_status
          else 'canceled'::public.background_job_status
        end,
        transition_version = transition_version + 1,
        canceled_at = case when v_has_effect then canceled_at else now() end,
        failed_at = case when v_has_effect then now() else failed_at end,
        error_code = case when v_has_effect then 'ambiguous_external_effect' else error_code end,
        error_message = case when v_has_effect then 'Cancellation raced with an external generation effect.' else error_message end,
        lease_token = null, lease_owner = null, lease_expires_at = null
    where id = p_job_id returning * into v_job;
    insert into public.domain_outbox (aggregate_type, aggregate_id, aggregate_version, event_type, payload)
    values ('generation_job', v_job.id, v_job.transition_version,
      case when v_has_effect then 'generation.job.dead_lettered' else 'generation.job.canceled' end,
      jsonb_build_object('jobId', v_job.id, 'workspaceId', v_job.workspace_id, 'userId', v_job.created_by));
    return jsonb_build_object('kind', 'terminal', 'job', to_jsonb(v_job));
  end if;
  if v_job.attempt_count >= v_job.max_attempts then
    update public.background_jobs set status = 'dead_letter', transition_version = transition_version + 1,
      failed_at = coalesce(failed_at, now()), error_code = coalesce(error_code, 'attempts_exhausted'),
      error_message = coalesce(error_message, 'Generation attempts exhausted.'),
      lease_token = null, lease_owner = null, lease_expires_at = null
    where id = p_job_id returning * into v_job;
    insert into public.domain_outbox (aggregate_type, aggregate_id, aggregate_version, event_type, payload)
    values ('generation_job', v_job.id, v_job.transition_version, 'generation.job.dead_lettered',
      jsonb_build_object('jobId', v_job.id, 'workspaceId', v_job.workspace_id, 'userId', v_job.created_by));
    return jsonb_build_object('kind', 'terminal', 'job', to_jsonb(v_job));
  end if;
  update public.background_jobs set status = 'running', attempt_count = attempt_count + 1,
    transition_version = transition_version + 1, lease_token = v_token,
    lease_owner = btrim(p_lease_owner), lease_expires_at = now() + make_interval(secs => p_lease_seconds),
    started_at = coalesce(started_at, now()), error_code = null, error_message = null
  where id = p_job_id returning * into v_job;
  return jsonb_build_object('kind', 'claimed', 'job', to_jsonb(v_job), 'lease_token', v_token);
end;
$$;

create or replace function public.settle_generation_job(
  p_job_id uuid, p_lease_token uuid, p_outcome text, p_result jsonb,
  p_error_code text, p_error_message text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.background_jobs%rowtype;
  v_event_type text;
  v_effect_started boolean;
begin
  select * into v_job from public.background_jobs where id = p_job_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'JOB_NOT_FOUND', detail = 'job_not_found'; end if;
  if v_job.lease_token is distinct from p_lease_token
     or v_job.status not in ('running', 'cancel_requested')
     or v_job.lease_expires_at <= now() then
    raise exception using errcode = 'P0001', message = 'STALE_JOB_LEASE', detail = 'stale_job_lease';
  end if;
  select exists(select 1 from public.generation_effect_attempts where job_id = p_job_id)
    into v_effect_started;

  if p_outcome = 'succeeded' then
    insert into public.job_effect_receipts (job_id, effect_kind, result)
    values (p_job_id, 'generation_result', coalesce(p_result, '{}'::jsonb))
    on conflict (job_id, effect_kind) do nothing;
    update public.generation_effect_attempts set state = 'completed', completed_at = now(), result = coalesce(p_result, '{}'::jsonb)
      where job_id = p_job_id;
    update public.background_jobs set status = 'succeeded', result = coalesce(p_result, '{}'::jsonb),
      transition_version = transition_version + 1, completed_at = now(),
      lease_token = null, lease_owner = null, lease_expires_at = null
    where id = p_job_id returning * into v_job;
    v_event_type := 'generation.job.succeeded';
  elsif p_outcome in ('failed', 'dead_letter') and v_effect_started then
    update public.generation_effect_attempts set state = 'ambiguous' where job_id = p_job_id;
    update public.background_jobs set status = 'dead_letter', transition_version = transition_version + 1,
      failed_at = now(), error_code = 'ambiguous_external_effect',
      error_message = 'External generation may have started; automatic replay is blocked.',
      lease_token = null, lease_owner = null, lease_expires_at = null
    where id = p_job_id returning * into v_job;
    v_event_type := 'generation.job.dead_lettered';
  elsif v_job.status = 'cancel_requested' or p_outcome = 'canceled' then
    update public.background_jobs set status = 'canceled', transition_version = transition_version + 1,
      canceled_at = now(), lease_token = null, lease_owner = null, lease_expires_at = null
    where id = p_job_id returning * into v_job;
    v_event_type := 'generation.job.canceled';
  elsif p_outcome = 'failed' then
    update public.background_jobs set status = 'failed', transition_version = transition_version + 1,
      failed_at = now(), error_code = coalesce(nullif(p_error_code, ''), 'executor_error'),
      error_message = coalesce(nullif(p_error_message, ''), 'Generation attempt failed.'),
      lease_token = null, lease_owner = null, lease_expires_at = null
    where id = p_job_id returning * into v_job;
    return jsonb_build_object('kind', 'failed', 'job', to_jsonb(v_job));
  elsif p_outcome = 'dead_letter' then
    update public.background_jobs set status = 'dead_letter', transition_version = transition_version + 1,
      failed_at = now(), error_code = coalesce(nullif(p_error_code, ''), 'executor_error'),
      error_message = coalesce(nullif(p_error_message, ''), 'Generation permanently failed.'),
      lease_token = null, lease_owner = null, lease_expires_at = null
    where id = p_job_id returning * into v_job;
    v_event_type := 'generation.job.dead_lettered';
  else
    raise exception using errcode = '22023', message = 'INVALID_JOB_OUTCOME', detail = 'invalid_job_transition';
  end if;
  insert into public.domain_outbox (aggregate_type, aggregate_id, aggregate_version, event_type, payload)
  values ('generation_job', v_job.id, v_job.transition_version, v_event_type,
    jsonb_build_object('jobId', v_job.id, 'workspaceId', v_job.workspace_id, 'userId', v_job.created_by));
  return jsonb_build_object('kind', 'terminal', 'job', to_jsonb(v_job));
end;
$$;

create or replace function public.compensate_generation_charge(
  p_workspace_id uuid, p_compensation_key text, p_job_id uuid,
  p_debit_transaction_id uuid, p_operator_user_id uuid, p_amount integer, p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_comp public.credit_compensations%rowtype;
  v_balance integer;
  v_refund_id uuid;
  v_debit_amount integer;
  v_compensated integer;
begin
  if char_length(btrim(p_compensation_key)) not between 1 and 128
     or char_length(btrim(p_reason)) not between 1 and 500 or p_amount <= 0 then
    raise exception using errcode = '22023', message = 'INVALID_COMPENSATION', detail = 'invalid_request';
  end if;
  insert into public.credit_compensations (compensation_key, workspace_id, job_id, debit_transaction_id, operator_user_id, amount, reason)
  values (btrim(p_compensation_key), p_workspace_id, p_job_id, p_debit_transaction_id, p_operator_user_id, p_amount, btrim(p_reason))
  on conflict (compensation_key) do nothing;
  select * into v_comp from public.credit_compensations where compensation_key = btrim(p_compensation_key) for update;
  if v_comp.workspace_id <> p_workspace_id or v_comp.job_id <> p_job_id
     or v_comp.debit_transaction_id <> p_debit_transaction_id or v_comp.operator_user_id <> p_operator_user_id
     or v_comp.amount <> p_amount or v_comp.reason <> btrim(p_reason) then
    raise exception using errcode = '23505', message = 'COMPENSATION_KEY_CONFLICT', detail = 'compensation_conflict';
  end if;
  if v_comp.completed_at is not null then
    return jsonb_build_object('transaction_id', v_comp.refund_transaction_id, 'replayed', true);
  end if;
  select -ct.amount into v_debit_amount from public.credit_transactions ct
  where ct.id = p_debit_transaction_id and ct.workspace_id = p_workspace_id
    and ct.job_id = p_job_id and ct.transaction_type = 'generation_deduct'
  for update;
  if not found then raise exception using errcode = '22023', message = 'INVALID_ORIGINAL_DEBIT', detail = 'invalid_request'; end if;
  select coalesce(sum(c.amount), 0)::integer into v_compensated
  from public.credit_compensations c
  where c.debit_transaction_id = p_debit_transaction_id and c.completed_at is not null;
  if v_compensated + p_amount > v_debit_amount then
    raise exception using errcode = '22023', message = 'COMPENSATION_EXCEEDS_DEBIT', detail = 'compensation_exceeds_debit';
  end if;
  select balance into strict v_balance from public.credit_balances where workspace_id = p_workspace_id for update;
  update public.credit_balances set balance = balance + p_amount, version = version + 1, updated_at = now()
  where workspace_id = p_workspace_id;
  insert into public.credit_transactions (workspace_id, user_id, transaction_type, amount, balance_after, job_id, description, metadata)
  values (p_workspace_id, p_operator_user_id, 'generation_refund', p_amount, v_balance + p_amount, p_job_id, btrim(p_reason),
    jsonb_build_object('compensation_key', btrim(p_compensation_key), 'original_debit_transaction_id', p_debit_transaction_id, 'operator_user_id', p_operator_user_id))
  returning id into v_refund_id;
  update public.credit_compensations set refund_transaction_id = v_refund_id, completed_at = now()
  where compensation_key = btrim(p_compensation_key);
  return jsonb_build_object('transaction_id', v_refund_id, 'replayed', false);
end;
$$;

create or replace function public.save_canvas_revision(
  p_canvas_id uuid, p_expected_revision bigint, p_content jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_canvas public.canvases%rowtype;
  v_actor uuid := auth.uid();
begin
  if v_actor is null then raise exception using errcode = '42501', message = 'AUTH_REQUIRED', detail = 'unauthorized'; end if;
  if p_expected_revision < 0 or p_content is null then raise exception using errcode = '22023', message = 'INVALID_CANVAS_COMMIT', detail = 'invalid_request'; end if;
  if not exists (
    select 1 from public.canvases c join public.projects p on p.id = c.project_id
    join public.workspace_members wm on wm.workspace_id = p.workspace_id
    where c.id = p_canvas_id and wm.user_id = v_actor
  ) then raise exception using errcode = 'P0002', message = 'CANVAS_NOT_FOUND', detail = 'canvas_not_found'; end if;
  update public.canvases set content = p_content, revision = revision + 1
  where id = p_canvas_id and revision = p_expected_revision returning * into v_canvas;
  if not found then
    select * into strict v_canvas from public.canvases where id = p_canvas_id;
    raise exception using errcode = '40001', message = 'CANVAS_REVISION_CONFLICT', detail = 'canvas_revision_conflict',
      hint = jsonb_build_object('expectedRevision', p_expected_revision, 'currentRevision', v_canvas.revision)::text;
  end if;
  insert into public.domain_outbox (aggregate_type, aggregate_id, aggregate_version, event_type, payload)
  values ('canvas', p_canvas_id, v_canvas.revision, 'canvas.updated',
    jsonb_build_object('canvasId', p_canvas_id, 'revision', v_canvas.revision, 'actorUserId', v_actor, 'source', 'browser'));
  return jsonb_build_object('revision', v_canvas.revision, 'replayed', false);
end;
$$;

-- Trusted variant retains the existing signature but validates Job ownership.
create or replace function public.commit_canvas_revision(
  p_canvas_id uuid, p_actor_user_id uuid, p_expected_revision bigint, p_content jsonb,
  p_job_id uuid, p_effect_kind text, p_event_type text, p_event_payload jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_canvas public.canvases%rowtype;
begin
  if p_job_id is null or p_effect_kind is null or char_length(btrim(p_effect_kind)) not between 1 and 100 then
    raise exception using errcode = '22023', message = 'INVALID_JOB_CANVAS_COMMIT', detail = 'invalid_request';
  end if;
  if p_event_type <> 'canvas.generated_asset_attached' then
    raise exception using errcode = '22023', message = 'INVALID_CANVAS_EVENT', detail = 'invalid_request';
  end if;
  select c.* into v_canvas from public.canvases c join public.projects p on p.id = c.project_id
  join public.background_jobs j on j.id = p_job_id and j.workspace_id = p.workspace_id
    and j.canvas_id = c.id and j.created_by = p_actor_user_id
  where c.id = p_canvas_id for update of c;
  if not found then raise exception using errcode = 'P0002', message = 'CANVAS_JOB_NOT_FOUND', detail = 'canvas_not_found'; end if;
  if exists(select 1 from public.job_effect_receipts where job_id = p_job_id and effect_kind = btrim(p_effect_kind)) then
    return jsonb_build_object('revision', v_canvas.revision, 'replayed', true);
  end if;
  if v_canvas.revision <> p_expected_revision then
    raise exception using errcode = '40001', message = 'CANVAS_REVISION_CONFLICT', detail = 'canvas_revision_conflict',
      hint = jsonb_build_object('expectedRevision', p_expected_revision, 'currentRevision', v_canvas.revision)::text;
  end if;
  update public.canvases set content = p_content, revision = revision + 1 where id = p_canvas_id returning * into v_canvas;
  insert into public.job_effect_receipts (job_id, effect_kind, result)
  values (p_job_id, btrim(p_effect_kind), jsonb_build_object('canvasId', p_canvas_id, 'revision', v_canvas.revision));
  insert into public.domain_outbox (aggregate_type, aggregate_id, aggregate_version, event_type, payload)
  values ('canvas', p_canvas_id, v_canvas.revision, 'canvas.generated_asset_attached',
    coalesce(p_event_payload, '{}'::jsonb) || jsonb_build_object('canvasId', p_canvas_id, 'revision', v_canvas.revision, 'jobId', p_job_id));
  return jsonb_build_object('revision', v_canvas.revision, 'replayed', false);
end;
$$;

revoke all on function public.begin_generation_effect(uuid, uuid) from public, anon, authenticated;
grant execute on function public.begin_generation_effect(uuid, uuid) to service_role;
revoke all on function public.commit_canvas_revision(uuid, uuid, bigint, jsonb, uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.commit_canvas_revision(uuid, uuid, bigint, jsonb, uuid, text, text, jsonb) to service_role;
revoke all on function public.save_canvas_revision(uuid, bigint, jsonb) from public, anon;
grant execute on function public.save_canvas_revision(uuid, bigint, jsonb) to authenticated, service_role;
