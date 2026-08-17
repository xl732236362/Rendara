-- Phase 2: transactional generation submission, lease-aware job transitions,
-- replay-safe compensation, Canvas OCC, and a transactional domain outbox.

alter table public.canvases
  add column revision bigint not null default 0;

alter table public.canvases
  add constraint canvases_revision_nonnegative check (revision >= 0);

alter table public.background_jobs
  add column transition_version bigint not null default 0,
  add column lease_token uuid,
  add column lease_owner text,
  add column lease_expires_at timestamptz,
  add column pgmq_message_id bigint,
  add column idempotency_key text,
  add column request_fingerprint text;

alter table public.background_jobs
  add constraint background_jobs_transition_version_nonnegative
    check (transition_version >= 0),
  add constraint background_jobs_attempt_bounds
    check (attempt_count >= 0 and max_attempts > 0),
  add constraint background_jobs_lease_shape
    check (
      (lease_token is null and lease_owner is null and lease_expires_at is null)
      or
      (lease_token is not null and lease_owner is not null and lease_expires_at is not null)
    ),
  add constraint background_jobs_idempotency_shape
    check (
      (idempotency_key is null and request_fingerprint is null)
      or
      (idempotency_key is not null and request_fingerprint is not null)
    );

create unique index background_jobs_submission_identity_key
  on public.background_jobs (workspace_id, created_by, job_type, idempotency_key)
  where idempotency_key is not null;

create index background_jobs_reclaimable_lease_idx
  on public.background_jobs (lease_expires_at, updated_at)
  where status in ('running', 'cancel_requested') and lease_token is not null;

create table public.generation_submission_keys (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  job_type public.background_job_type not null,
  idempotency_key text not null,
  request_fingerprint text not null,
  job_id uuid references public.background_jobs(id) on delete restrict,
  debit_transaction_id uuid references public.credit_transactions(id) on delete restrict,
  created_at timestamptz not null default now(),
  committed_at timestamptz,
  primary key (workspace_id, user_id, job_type, idempotency_key),
  constraint generation_submission_key_length check (
    char_length(idempotency_key) between 1 and 128
  ),
  constraint generation_submission_fingerprint_length check (
    char_length(request_fingerprint) between 16 and 128
  ),
  constraint generation_submission_commit_shape check (
    (committed_at is null and job_id is null)
    or
    (committed_at is not null and job_id is not null)
  )
);

create table public.job_effect_receipts (
  job_id uuid not null references public.background_jobs(id) on delete cascade,
  effect_kind text not null,
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (job_id, effect_kind),
  constraint job_effect_kind_length check (char_length(effect_kind) between 1 and 100)
);

create table public.credit_compensations (
  compensation_key text primary key,
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  job_id uuid not null references public.background_jobs(id) on delete restrict,
  debit_transaction_id uuid not null references public.credit_transactions(id) on delete restrict,
  refund_transaction_id uuid references public.credit_transactions(id) on delete restrict,
  operator_user_id uuid not null references auth.users(id) on delete restrict,
  amount integer not null check (amount > 0),
  reason text not null,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint credit_compensation_key_length check (
    char_length(compensation_key) between 1 and 128
  ),
  constraint credit_compensation_reason_length check (
    char_length(btrim(reason)) between 1 and 500
  ),
  constraint credit_compensation_completion_shape check (
    (completed_at is null and refund_transaction_id is null)
    or
    (completed_at is not null and refund_transaction_id is not null)
  )
);

create table public.domain_outbox (
  event_id uuid primary key default gen_random_uuid(),
  aggregate_type text not null,
  aggregate_id uuid not null,
  aggregate_version bigint not null check (aggregate_version >= 0),
  event_type text not null,
  schema_version integer not null default 1 check (schema_version > 0),
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  available_at timestamptz not null default now(),
  published_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  locked_by text,
  locked_at timestamptz,
  last_error_code text,
  constraint domain_outbox_aggregate_type_length check (
    char_length(aggregate_type) between 1 and 100
  ),
  constraint domain_outbox_event_type_length check (
    char_length(event_type) between 1 and 150
  ),
  constraint domain_outbox_lock_shape check (
    (locked_by is null and locked_at is null)
    or
    (locked_by is not null and locked_at is not null)
  )
);

create index domain_outbox_unpublished_idx
  on public.domain_outbox (available_at, occurred_at, event_id)
  where published_at is null;

create table public.domain_inbox (
  consumer_name text not null,
  event_id uuid not null,
  processed_at timestamptz not null default now(),
  primary key (consumer_name, event_id),
  constraint domain_inbox_consumer_name_length check (
    char_length(consumer_name) between 1 and 100
  )
);

alter table public.generation_submission_keys enable row level security;
alter table public.job_effect_receipts enable row level security;
alter table public.credit_compensations enable row level security;
alter table public.domain_outbox enable row level security;
alter table public.domain_inbox enable row level security;

revoke all on table public.generation_submission_keys from anon, authenticated;
revoke all on table public.job_effect_receipts from anon, authenticated;
revoke all on table public.credit_compensations from anon, authenticated;
revoke all on table public.domain_outbox from anon, authenticated;
revoke all on table public.domain_inbox from anon, authenticated;

grant select, insert, update, delete on table public.generation_submission_keys to service_role;
grant select, insert, update, delete on table public.job_effect_receipts to service_role;
grant select, insert, update, delete on table public.credit_compensations to service_role;
grant select, insert, update, delete on table public.domain_outbox to service_role;
grant select, insert, update, delete on table public.domain_inbox to service_role;

create or replace function public.submit_generation_job(
  p_workspace_id uuid,
  p_user_id uuid,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_job_type public.background_job_type,
  p_payload jsonb,
  p_credits_cost integer,
  p_description text,
  p_project_id uuid,
  p_canvas_id uuid,
  p_session_id uuid,
  p_thread_id text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key public.generation_submission_keys%rowtype;
  v_job public.background_jobs%rowtype;
  v_queue_name text;
  v_balance integer;
  v_new_balance integer;
  v_debit_id uuid;
  v_message_id bigint;
  v_queue_payload jsonb;
begin
  if p_idempotency_key is null
     or char_length(btrim(p_idempotency_key)) not between 1 and 128 then
    raise exception using
      errcode = '22023',
      message = 'INVALID_IDEMPOTENCY_KEY',
      detail = 'invalid_request';
  end if;
  if p_request_fingerprint is null
     or char_length(p_request_fingerprint) not between 16 and 128 then
    raise exception using
      errcode = '22023',
      message = 'INVALID_REQUEST_FINGERPRINT',
      detail = 'invalid_request';
  end if;
  if p_credits_cost < 0 then
    raise exception using
      errcode = '22023',
      message = 'INVALID_CREDIT_COST',
      detail = 'invalid_request';
  end if;
  if not exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = p_workspace_id
      and wm.user_id = p_user_id
  ) then
    raise exception using
      errcode = '42501',
      message = 'WORKSPACE_ACCESS_DENIED',
      detail = 'forbidden';
  end if;
  if p_project_id is not null and not exists (
    select 1 from public.projects p
    where p.id = p_project_id and p.workspace_id = p_workspace_id
  ) then
    raise exception using errcode = '42501', message = 'PROJECT_ACCESS_DENIED', detail = 'forbidden';
  end if;
  if p_canvas_id is not null and not exists (
    select 1
    from public.canvases c
    join public.projects p on p.id = c.project_id
    where c.id = p_canvas_id and p.workspace_id = p_workspace_id
  ) then
    raise exception using errcode = '42501', message = 'CANVAS_ACCESS_DENIED', detail = 'forbidden';
  end if;
  if p_session_id is not null and not exists (
    select 1
    from public.chat_sessions cs
    join public.canvases c on c.id = cs.canvas_id
    join public.projects p on p.id = c.project_id
    where cs.id = p_session_id and p.workspace_id = p_workspace_id
  ) then
    raise exception using errcode = '42501', message = 'SESSION_ACCESS_DENIED', detail = 'forbidden';
  end if;

  insert into public.generation_submission_keys (
    workspace_id, user_id, job_type, idempotency_key, request_fingerprint
  ) values (
    p_workspace_id,
    p_user_id,
    p_job_type,
    btrim(p_idempotency_key),
    p_request_fingerprint
  )
  on conflict (workspace_id, user_id, job_type, idempotency_key) do nothing;

  select * into v_key
  from public.generation_submission_keys
  where workspace_id = p_workspace_id
    and user_id = p_user_id
    and job_type = p_job_type
    and idempotency_key = btrim(p_idempotency_key)
  for update;

  if v_key.request_fingerprint <> p_request_fingerprint then
    raise exception using
      errcode = '23505',
      message = 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST',
      detail = 'idempotency_conflict';
  end if;

  if v_key.committed_at is not null then
    select * into strict v_job
    from public.background_jobs
    where id = v_key.job_id;
    return jsonb_build_object(
      'job', to_jsonb(v_job),
      'debit_transaction_id', v_key.debit_transaction_id,
      'replayed', true
    );
  end if;

  if p_credits_cost > 0 then
    select balance into v_balance
    from public.credit_balances
    where workspace_id = p_workspace_id
    for update;

    if not found then
      raise exception using errcode = 'P0001', message = 'NO_CREDIT_BALANCE', detail = 'credit_deduct_failed';
    end if;
    if v_balance < p_credits_cost then
      raise exception using errcode = 'P0001', message = 'INSUFFICIENT_CREDITS', detail = 'insufficient_credits';
    end if;
  end if;

  v_queue_name := case p_job_type
    when 'image_generation' then 'image_generation_jobs'
    when 'video_generation' then 'video_generation_jobs'
    else null
  end;
  if v_queue_name is null then
    raise exception using errcode = '22023', message = 'UNSUPPORTED_JOB_TYPE', detail = 'invalid_request';
  end if;

  insert into public.background_jobs (
    workspace_id,
    project_id,
    canvas_id,
    session_id,
    thread_id,
    queue_name,
    job_type,
    status,
    payload,
    created_by,
    idempotency_key,
    request_fingerprint,
    credits_cost
  ) values (
    p_workspace_id,
    p_project_id,
    p_canvas_id,
    p_session_id,
    p_thread_id,
    v_queue_name,
    p_job_type,
    'queued',
    coalesce(p_payload, '{}'::jsonb),
    p_user_id,
    btrim(p_idempotency_key),
    p_request_fingerprint,
    p_credits_cost
  ) returning * into v_job;

  if p_credits_cost > 0 then
    v_new_balance := v_balance - p_credits_cost;
    update public.credit_balances
    set balance = v_new_balance,
        version = version + 1,
        updated_at = now()
    where workspace_id = p_workspace_id;

    insert into public.credit_transactions (
      workspace_id,
      user_id,
      transaction_type,
      amount,
      balance_after,
      job_id,
      description,
      metadata
    ) values (
      p_workspace_id,
      p_user_id,
      'generation_deduct',
      -p_credits_cost,
      v_new_balance,
      v_job.id,
      p_description,
      jsonb_build_object('business_key', 'generation-debit:' || v_job.id::text)
    ) returning id into v_debit_id;

    update public.background_jobs
    set credits_transaction_id = v_debit_id
    where id = v_job.id
    returning * into v_job;
  end if;

  v_queue_payload := jsonb_build_object(
    'job_id', v_job.id,
    'job_type', p_job_type,
    'workspace_id', p_workspace_id,
    'schemaVersion', 1,
    'type', p_job_type,
    'payload', coalesce(p_payload, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
      'job_id', v_job.id,
      'workspace_id', p_workspace_id,
      'project_id', p_project_id,
      'canvas_id', p_canvas_id,
      'session_id', p_session_id,
      'thread_id', p_thread_id
    ))
  ) || jsonb_strip_nulls(jsonb_build_object(
    'project_id', p_project_id,
    'canvas_id', p_canvas_id,
    'session_id', p_session_id,
    'thread_id', p_thread_id
  ));

  select pgmq.send(v_queue_name, v_queue_payload, 0) into v_message_id;

  update public.background_jobs
  set pgmq_message_id = v_message_id
  where id = v_job.id
  returning * into v_job;

  update public.generation_submission_keys
  set job_id = v_job.id,
      debit_transaction_id = v_debit_id,
      committed_at = now()
  where workspace_id = p_workspace_id
    and user_id = p_user_id
    and job_type = p_job_type
    and idempotency_key = btrim(p_idempotency_key);

  return jsonb_build_object(
    'job', to_jsonb(v_job),
    'debit_transaction_id', v_debit_id,
    'replayed', false
  );
end;
$$;

create or replace function public.request_generation_cancellation(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.background_jobs%rowtype;
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED', detail = 'unauthorized';
  end if;

  select * into v_job
  from public.background_jobs
  where id = p_job_id and created_by = v_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'JOB_NOT_FOUND', detail = 'job_not_found';
  end if;

  if v_job.status = 'canceled' then
    return jsonb_build_object('job', to_jsonb(v_job), 'replayed', true);
  end if;
  if v_job.status in ('succeeded', 'dead_letter') then
    raise exception using errcode = 'P0001', message = 'JOB_ALREADY_TERMINAL', detail = 'job_already_terminal';
  end if;

  update public.background_jobs
  set status = case
        when v_job.status in ('queued', 'failed') then 'canceled'::public.background_job_status
        else 'cancel_requested'::public.background_job_status
      end,
      transition_version = transition_version + 1,
      canceled_at = case
        when v_job.status in ('queued', 'failed') then now()
        else canceled_at
      end
  where id = p_job_id
  returning * into v_job;

  if v_job.status = 'canceled' then
    insert into public.domain_outbox (
      aggregate_type, aggregate_id, aggregate_version, event_type, payload
    ) values (
      'generation_job', v_job.id, v_job.transition_version, 'generation.job.canceled',
      jsonb_build_object('jobId', v_job.id, 'workspaceId', v_job.workspace_id)
    );
  end if;

  return jsonb_build_object('job', to_jsonb(v_job), 'replayed', false);
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
begin
  if char_length(btrim(p_lease_owner)) not between 1 and 100
     or p_lease_seconds not between 5 and 3600 then
    raise exception using errcode = '22023', message = 'INVALID_LEASE', detail = 'invalid_request';
  end if;

  select * into v_job from public.background_jobs where id = p_job_id for update;
  if not found then
    return jsonb_build_object('kind', 'missing');
  end if;
  if v_job.status in ('succeeded', 'canceled', 'dead_letter') then
    return jsonb_build_object('kind', 'terminal', 'job', to_jsonb(v_job));
  end if;
  if v_job.status = 'cancel_requested' then
    update public.background_jobs
    set status = 'canceled',
        transition_version = transition_version + 1,
        canceled_at = now(),
        lease_token = null,
        lease_owner = null,
        lease_expires_at = null
    where id = p_job_id
    returning * into v_job;
    insert into public.domain_outbox (
      aggregate_type, aggregate_id, aggregate_version, event_type, payload
    ) values (
      'generation_job', v_job.id, v_job.transition_version, 'generation.job.canceled',
      jsonb_build_object('jobId', v_job.id, 'workspaceId', v_job.workspace_id)
    );
    return jsonb_build_object('kind', 'terminal', 'job', to_jsonb(v_job));
  end if;
  if v_job.status = 'running' and v_job.lease_expires_at > now() then
    return jsonb_build_object('kind', 'busy', 'job', to_jsonb(v_job));
  end if;
  if v_job.attempt_count >= v_job.max_attempts then
    update public.background_jobs
    set status = 'dead_letter',
        transition_version = transition_version + 1,
        failed_at = coalesce(failed_at, now()),
        error_code = coalesce(error_code, 'attempts_exhausted'),
        error_message = coalesce(error_message, 'Generation attempts exhausted.'),
        lease_token = null,
        lease_owner = null,
        lease_expires_at = null
    where id = p_job_id
    returning * into v_job;
    insert into public.domain_outbox (
      aggregate_type, aggregate_id, aggregate_version, event_type, payload
    ) values (
      'generation_job', v_job.id, v_job.transition_version, 'generation.job.dead_lettered',
      jsonb_build_object('jobId', v_job.id, 'workspaceId', v_job.workspace_id)
    );
    return jsonb_build_object('kind', 'terminal', 'job', to_jsonb(v_job));
  end if;

  update public.background_jobs
  set status = 'running',
      attempt_count = attempt_count + 1,
      transition_version = transition_version + 1,
      lease_token = v_token,
      lease_owner = btrim(p_lease_owner),
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      started_at = coalesce(started_at, now()),
      error_code = null,
      error_message = null
  where id = p_job_id
  returning * into v_job;

  return jsonb_build_object('kind', 'claimed', 'job', to_jsonb(v_job), 'lease_token', v_token);
end;
$$;

create or replace function public.renew_generation_job_lease(
  p_job_id uuid,
  p_lease_token uuid,
  p_lease_seconds integer
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.background_jobs%rowtype;
begin
  if p_lease_seconds not between 5 and 3600 then
    raise exception using errcode = '22023', message = 'INVALID_LEASE', detail = 'invalid_request';
  end if;
  update public.background_jobs
  set lease_expires_at = now() + make_interval(secs => p_lease_seconds)
  where id = p_job_id
    and lease_token = p_lease_token
    and status in ('running', 'cancel_requested')
    and lease_expires_at > now()
  returning * into v_job;
  if not found then
    raise exception using errcode = 'P0001', message = 'STALE_JOB_LEASE', detail = 'stale_job_lease';
  end if;
  return to_jsonb(v_job);
end;
$$;

create or replace function public.settle_generation_job(
  p_job_id uuid,
  p_lease_token uuid,
  p_outcome text,
  p_result jsonb,
  p_error_code text,
  p_error_message text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.background_jobs%rowtype;
  v_event_type text;
begin
  select * into v_job from public.background_jobs where id = p_job_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'JOB_NOT_FOUND', detail = 'job_not_found';
  end if;
  if v_job.lease_token is distinct from p_lease_token
     or v_job.status not in ('running', 'cancel_requested') then
    raise exception using errcode = 'P0001', message = 'STALE_JOB_LEASE', detail = 'stale_job_lease';
  end if;

  if v_job.status = 'cancel_requested' or p_outcome = 'canceled' then
    update public.background_jobs
    set status = 'canceled',
        transition_version = transition_version + 1,
        canceled_at = now(),
        lease_token = null,
        lease_owner = null,
        lease_expires_at = null
    where id = p_job_id
    returning * into v_job;
    v_event_type := 'generation.job.canceled';
  elsif p_outcome = 'succeeded' then
    insert into public.job_effect_receipts (job_id, effect_kind, result)
    values (p_job_id, 'generation_result', coalesce(p_result, '{}'::jsonb))
    on conflict (job_id, effect_kind) do nothing;
    update public.background_jobs
    set status = 'succeeded',
        result = coalesce(p_result, '{}'::jsonb),
        transition_version = transition_version + 1,
        completed_at = now(),
        lease_token = null,
        lease_owner = null,
        lease_expires_at = null
    where id = p_job_id
    returning * into v_job;
    v_event_type := 'generation.job.succeeded';
  elsif p_outcome = 'failed' then
    update public.background_jobs
    set status = 'failed',
        transition_version = transition_version + 1,
        failed_at = now(),
        error_code = coalesce(nullif(p_error_code, ''), 'executor_error'),
        error_message = coalesce(nullif(p_error_message, ''), 'Generation attempt failed.'),
        lease_token = null,
        lease_owner = null,
        lease_expires_at = null
    where id = p_job_id
    returning * into v_job;
    return jsonb_build_object('kind', 'failed', 'job', to_jsonb(v_job));
  elsif p_outcome = 'dead_letter' then
    update public.background_jobs
    set status = 'dead_letter',
        transition_version = transition_version + 1,
        failed_at = now(),
        error_code = coalesce(nullif(p_error_code, ''), 'executor_error'),
        error_message = coalesce(nullif(p_error_message, ''), 'Generation permanently failed.'),
        lease_token = null,
        lease_owner = null,
        lease_expires_at = null
    where id = p_job_id
    returning * into v_job;
    v_event_type := 'generation.job.dead_lettered';
  else
    raise exception using errcode = '22023', message = 'INVALID_JOB_OUTCOME', detail = 'invalid_job_transition';
  end if;

  insert into public.domain_outbox (
    aggregate_type, aggregate_id, aggregate_version, event_type, payload
  ) values (
    'generation_job', v_job.id, v_job.transition_version, v_event_type,
    jsonb_build_object('jobId', v_job.id, 'workspaceId', v_job.workspace_id)
  );

  return jsonb_build_object('kind', 'terminal', 'job', to_jsonb(v_job));
end;
$$;

create or replace function public.compensate_generation_charge(
  p_workspace_id uuid,
  p_compensation_key text,
  p_job_id uuid,
  p_debit_transaction_id uuid,
  p_operator_user_id uuid,
  p_amount integer,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_comp public.credit_compensations%rowtype;
  v_balance integer;
  v_refund_id uuid;
begin
  if char_length(btrim(p_compensation_key)) not between 1 and 128
     or char_length(btrim(p_reason)) not between 1 and 500
     or p_amount <= 0 then
    raise exception using errcode = '22023', message = 'INVALID_COMPENSATION', detail = 'invalid_request';
  end if;

  insert into public.credit_compensations (
    compensation_key, workspace_id, job_id, debit_transaction_id,
    operator_user_id, amount, reason
  ) values (
    btrim(p_compensation_key), p_workspace_id, p_job_id,
    p_debit_transaction_id, p_operator_user_id, p_amount, btrim(p_reason)
  ) on conflict (compensation_key) do nothing;

  select * into v_comp
  from public.credit_compensations
  where compensation_key = btrim(p_compensation_key)
  for update;

  if v_comp.workspace_id <> p_workspace_id
     or v_comp.job_id <> p_job_id
     or v_comp.debit_transaction_id <> p_debit_transaction_id
     or v_comp.operator_user_id <> p_operator_user_id
     or v_comp.amount <> p_amount
     or v_comp.reason <> btrim(p_reason) then
    raise exception using errcode = '23505', message = 'COMPENSATION_KEY_CONFLICT', detail = 'compensation_conflict';
  end if;
  if v_comp.completed_at is not null then
    return jsonb_build_object(
      'transaction_id', v_comp.refund_transaction_id,
      'replayed', true
    );
  end if;
  if not exists (
    select 1 from public.credit_transactions ct
    where ct.id = p_debit_transaction_id
      and ct.workspace_id = p_workspace_id
      and ct.job_id = p_job_id
      and ct.transaction_type = 'generation_deduct'
  ) then
    raise exception using errcode = '22023', message = 'INVALID_ORIGINAL_DEBIT', detail = 'invalid_request';
  end if;

  select balance into strict v_balance
  from public.credit_balances
  where workspace_id = p_workspace_id
  for update;

  update public.credit_balances
  set balance = balance + p_amount,
      version = version + 1,
      updated_at = now()
  where workspace_id = p_workspace_id;

  insert into public.credit_transactions (
    workspace_id, user_id, transaction_type, amount, balance_after,
    job_id, description, metadata
  ) values (
    p_workspace_id, p_operator_user_id, 'generation_refund', p_amount,
    v_balance + p_amount, p_job_id, btrim(p_reason),
    jsonb_build_object(
      'compensation_key', btrim(p_compensation_key),
      'original_debit_transaction_id', p_debit_transaction_id,
      'operator_user_id', p_operator_user_id
    )
  ) returning id into v_refund_id;

  update public.credit_compensations
  set refund_transaction_id = v_refund_id,
      completed_at = now()
  where compensation_key = btrim(p_compensation_key);

  return jsonb_build_object('transaction_id', v_refund_id, 'replayed', false);
end;
$$;

create or replace function public.commit_canvas_revision(
  p_canvas_id uuid,
  p_actor_user_id uuid,
  p_expected_revision bigint,
  p_content jsonb,
  p_job_id uuid,
  p_effect_kind text,
  p_event_type text,
  p_event_payload jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_canvas public.canvases%rowtype;
  v_caller uuid := auth.uid();
begin
  if v_caller is not null and v_caller <> p_actor_user_id then
    raise exception using errcode = '42501', message = 'ACTOR_MISMATCH', detail = 'forbidden';
  end if;
  if p_expected_revision < 0 or p_content is null then
    raise exception using errcode = '22023', message = 'INVALID_CANVAS_COMMIT', detail = 'invalid_request';
  end if;
  if not exists (
    select 1
    from public.canvases c
    join public.projects p on p.id = c.project_id
    join public.workspace_members wm on wm.workspace_id = p.workspace_id
    where c.id = p_canvas_id and wm.user_id = p_actor_user_id
  ) then
    raise exception using errcode = 'P0002', message = 'CANVAS_NOT_FOUND', detail = 'canvas_not_found';
  end if;

  if p_job_id is not null and p_effect_kind is not null and exists (
    select 1 from public.job_effect_receipts
    where job_id = p_job_id and effect_kind = p_effect_kind
  ) then
    select * into strict v_canvas from public.canvases where id = p_canvas_id;
    return jsonb_build_object('revision', v_canvas.revision, 'replayed', true);
  end if;

  update public.canvases
  set content = p_content,
      revision = revision + 1
  where id = p_canvas_id and revision = p_expected_revision
  returning * into v_canvas;

  if not found then
    select * into strict v_canvas from public.canvases where id = p_canvas_id;
    raise exception using
      errcode = '40001',
      message = 'CANVAS_REVISION_CONFLICT',
      detail = 'canvas_revision_conflict',
      hint = jsonb_build_object(
        'expectedRevision', p_expected_revision,
        'currentRevision', v_canvas.revision
      )::text;
  end if;

  if p_job_id is not null and p_effect_kind is not null then
    insert into public.job_effect_receipts (job_id, effect_kind, result)
    values (
      p_job_id,
      p_effect_kind,
      jsonb_build_object('canvasId', p_canvas_id, 'revision', v_canvas.revision)
    );
  end if;

  insert into public.domain_outbox (
    aggregate_type, aggregate_id, aggregate_version, event_type, payload
  ) values (
    'canvas',
    p_canvas_id,
    v_canvas.revision,
    coalesce(nullif(p_event_type, ''), 'canvas.revision.committed'),
    coalesce(p_event_payload, '{}'::jsonb) || jsonb_build_object(
      'canvasId', p_canvas_id,
      'revision', v_canvas.revision
    )
  );

  return jsonb_build_object('revision', v_canvas.revision, 'replayed', false);
end;
$$;

create or replace function public.claim_domain_outbox(
  p_limit integer,
  p_worker_id text
) returns setof public.domain_outbox
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_limit not between 1 and 100 or char_length(btrim(p_worker_id)) not between 1 and 100 then
    raise exception using errcode = '22023', message = 'INVALID_OUTBOX_CLAIM', detail = 'invalid_request';
  end if;
  return query
  with candidates as (
    select o.event_id
    from public.domain_outbox o
    where o.published_at is null
      and o.available_at <= now()
      and (o.locked_at is null or o.locked_at < now() - interval '5 minutes')
    order by o.available_at, o.occurred_at, o.event_id
    limit p_limit
    for update skip locked
  )
  update public.domain_outbox o
  set locked_by = btrim(p_worker_id),
      locked_at = now(),
      attempt_count = o.attempt_count + 1
  from candidates c
  where o.event_id = c.event_id
  returning o.*;
end;
$$;

create or replace function public.ack_domain_outbox(
  p_event_id uuid,
  p_worker_id text
) returns boolean
language sql
security definer
set search_path = ''
as $$
  with acknowledged as (
    update public.domain_outbox
    set published_at = now(), locked_by = null, locked_at = null, last_error_code = null
    where event_id = p_event_id
      and locked_by = btrim(p_worker_id)
      and published_at is null
    returning 1
  )
  select exists(select 1 from acknowledged);
$$;

create or replace function public.fail_domain_outbox(
  p_event_id uuid,
  p_worker_id text,
  p_error_code text
) returns boolean
language sql
security definer
set search_path = ''
as $$
  with failed as (
    update public.domain_outbox
    set available_at = now() + make_interval(secs => least(300, greatest(1, attempt_count * attempt_count))),
        locked_by = null,
        locked_at = null,
        last_error_code = left(coalesce(nullif(p_error_code, ''), 'publish_failed'), 100)
    where event_id = p_event_id
      and locked_by = btrim(p_worker_id)
      and published_at is null
    returning 1
  )
  select exists(select 1 from failed);
$$;

revoke all on function public.submit_generation_job(
  uuid, uuid, text, text, public.background_job_type, jsonb, integer,
  text, uuid, uuid, uuid, text
) from public, anon, authenticated;
grant execute on function public.submit_generation_job(
  uuid, uuid, text, text, public.background_job_type, jsonb, integer,
  text, uuid, uuid, uuid, text
) to service_role;

revoke all on function public.request_generation_cancellation(uuid)
  from public, anon;
grant execute on function public.request_generation_cancellation(uuid)
  to authenticated, service_role;

revoke all on function public.claim_generation_job(uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.claim_generation_job(uuid, text, integer)
  to service_role;

revoke all on function public.renew_generation_job_lease(uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.renew_generation_job_lease(uuid, uuid, integer)
  to service_role;

revoke all on function public.settle_generation_job(uuid, uuid, text, jsonb, text, text)
  from public, anon, authenticated;
grant execute on function public.settle_generation_job(uuid, uuid, text, jsonb, text, text)
  to service_role;

revoke all on function public.compensate_generation_charge(
  uuid, text, uuid, uuid, uuid, integer, text
) from public, anon, authenticated;
grant execute on function public.compensate_generation_charge(
  uuid, text, uuid, uuid, uuid, integer, text
) to service_role;

revoke all on function public.commit_canvas_revision(
  uuid, uuid, bigint, jsonb, uuid, text, text, jsonb
) from public, anon;
grant execute on function public.commit_canvas_revision(
  uuid, uuid, bigint, jsonb, uuid, text, text, jsonb
) to authenticated, service_role;

revoke all on function public.claim_domain_outbox(integer, text)
  from public, anon, authenticated;
grant execute on function public.claim_domain_outbox(integer, text)
  to service_role;

revoke all on function public.ack_domain_outbox(uuid, text)
  from public, anon, authenticated;
grant execute on function public.ack_domain_outbox(uuid, text)
  to service_role;

revoke all on function public.fail_domain_outbox(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.fail_domain_outbox(uuid, text, text)
  to service_role;

comment on function public.submit_generation_job(
  uuid, uuid, text, text, public.background_job_type, jsonb, integer,
  text, uuid, uuid, uuid, text
) is 'Atomically reserves an idempotency key, charges once, creates a job, and sends its PGMQ message.';

comment on function public.commit_canvas_revision(
  uuid, uuid, bigint, jsonb, uuid, text, text, jsonb
) is 'Commits Canvas content with revision CAS, optional job effect receipt, and transactional outbox event.';
