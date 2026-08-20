-- Durable generated-asset attachment and Agent lease recovery.

create table public.generated_asset_attachment_intents (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.background_jobs(id) on delete cascade,
  effect_kind text not null,
  state text not null default 'pending' check (
    state in ('pending', 'running', 'retry_wait', 'attached', 'failed', 'canceled')
  ),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  canvas_id uuid not null references public.canvases(id) on delete cascade,
  session_id uuid references public.chat_sessions(id) on delete set null,
  user_id uuid not null references auth.users(id) on delete cascade,
  media_type text not null check (media_type in ('image', 'video')),
  placement_policy jsonb not null,
  run_id uuid references public.agent_runs(id) on delete set null,
  attempt_id uuid references public.agent_run_attempts(attempt_id) on delete set null,
  fencing_token bigint check (fencing_token is null or fencing_token >= 0),
  logical_tool_call_id text,
  input_digest text,
  claim_owner text,
  claim_expires_at timestamptz,
  claim_fencing_token bigint not null default 0 check (claim_fencing_token >= 0),
  attempt_count integer not null default 0 check (attempt_count between 0 and 8),
  next_attempt_at timestamptz not null default now(),
  result jsonb,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  attached_at timestamptz,
  unique (job_id, effect_kind),
  constraint generated_asset_attachment_effect_kind check (
    effect_kind = 'generated_asset_attached'
  ),
  constraint generated_asset_attachment_error_code_length check (
    error_code is null or char_length(error_code) between 1 and 64
  ),
  constraint generated_asset_attachment_claim_shape check (
    (state = 'running' and claim_owner is not null and claim_expires_at is not null)
    or
    (state <> 'running' and claim_owner is null and claim_expires_at is null)
  ),
  constraint generated_asset_attachment_result_shape check (
    (state = 'attached' and result is not null and attached_at is not null)
    or
    (state <> 'attached' and result is null and attached_at is null)
  ),
  constraint generated_asset_attachment_agent_shape check (
    (run_id is null and attempt_id is null and fencing_token is null
      and logical_tool_call_id is null and input_digest is null)
    or
    (run_id is not null and attempt_id is not null and fencing_token is not null
      and logical_tool_call_id is not null and input_digest is not null)
  ),
  constraint generated_asset_attachment_placement_shape check (
    jsonb_typeof(placement_policy) = 'object'
    and (
      placement_policy = '{"kind":"auto_right"}'::jsonb
      or (
        placement_policy->>'kind' = 'explicit'
        and jsonb_typeof(placement_policy->'x') = 'number'
        and jsonb_typeof(placement_policy->'y') = 'number'
        and jsonb_typeof(placement_policy->'width') = 'number'
        and jsonb_typeof(placement_policy->'height') = 'number'
        and (placement_policy->>'width')::numeric > 0
        and (placement_policy->>'height')::numeric > 0
        and placement_policy - array['kind', 'x', 'y', 'width', 'height'] = '{}'::jsonb
      )
    )
  )
);

create table public.generated_asset_recovery_audits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  canvas_id uuid not null references public.canvases(id) on delete cascade,
  job_id uuid not null references public.background_jobs(id) on delete cascade,
  effect_kind text not null check (effect_kind = 'generated_asset_attached'),
  intent_id uuid not null references public.generated_asset_attachment_intents(id)
    on delete cascade,
  state text not null default 'pending' check (state in ('pending', 'attached', 'failed')),
  result jsonb,
  error_code text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (user_id, canvas_id, job_id, effect_kind),
  constraint generated_asset_recovery_audit_result_shape check (
    (state = 'pending' and result is null and completed_at is null)
    or (state = 'attached' and result is not null and completed_at is not null)
    or (state = 'failed' and result is null and completed_at is not null)
  )
);

create index generated_asset_attachment_job_idx
  on public.generated_asset_attachment_intents(job_id);
create index generated_asset_attachment_canvas_session_idx
  on public.generated_asset_attachment_intents(canvas_id, session_id, created_at desc);
create index generated_asset_attachment_due_idx
  on public.generated_asset_attachment_intents(state, next_attempt_at, created_at)
  where state in ('pending', 'retry_wait');
create index generated_asset_attachment_expired_claim_idx
  on public.generated_asset_attachment_intents(claim_expires_at, created_at)
  where state = 'running';
create index generated_asset_attachment_run_attempt_idx
  on public.generated_asset_attachment_intents(run_id, attempt_id)
  where run_id is not null;
create index generated_asset_recovery_intent_idx
  on public.generated_asset_recovery_audits(intent_id);
create index generated_asset_recovery_job_idx
  on public.generated_asset_recovery_audits(job_id);

alter table public.generated_asset_attachment_intents enable row level security;
alter table public.generated_asset_attachment_intents force row level security;
alter table public.generated_asset_recovery_audits enable row level security;
alter table public.generated_asset_recovery_audits force row level security;
revoke all on table public.generated_asset_attachment_intents
  from public, anon, authenticated;
revoke all on table public.generated_asset_recovery_audits
  from public, anon, authenticated;
grant select, insert, update, delete
  on table public.generated_asset_attachment_intents to service_role;
grant select, insert, update, delete
  on table public.generated_asset_recovery_audits to service_role;

-- The overload keeps public/direct generation on the existing 12-argument
-- contract while Agent calls atomically add an intent before PGMQ visibility.
create function public.submit_generation_job(
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
  p_thread_id text,
  p_attachment_intent jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_submission jsonb;
  v_job_id uuid;
  v_intent public.generated_asset_attachment_intents%rowtype;
  v_run public.agent_runs%rowtype;
  v_attempt public.agent_run_attempts%rowtype;
  v_effect public.agent_effects%rowtype;
  v_intent_id uuid;
  v_media_type text;
begin
  v_submission := public.submit_generation_job(
    p_workspace_id, p_user_id, p_idempotency_key, p_request_fingerprint,
    p_job_type, p_payload, p_credits_cost, p_description, p_project_id,
    p_canvas_id, p_session_id, p_thread_id
  );
  if p_attachment_intent is null then return v_submission; end if;
  if jsonb_typeof(p_attachment_intent) <> 'object'
     or (select count(*) from jsonb_object_keys(p_attachment_intent)) <> 9 then
    raise exception using errcode = '22023', message = 'INVALID_ATTACHMENT_INTENT',
      detail = 'invalid_attachment_intent';
  end if;

  v_job_id := (v_submission->'job'->>'id')::uuid;
  v_intent_id := (p_attachment_intent->>'intentId')::uuid;
  v_media_type := p_attachment_intent->>'mediaType';
  if p_canvas_id is null or p_project_id is null or p_session_id is null
     or p_attachment_intent->>'effectKind' <> 'generated_asset_attached'
     or v_media_type not in ('image', 'video')
     or (v_media_type = 'image') <> (p_job_type = 'image_generation')
     or (v_media_type = 'video') <> (p_job_type = 'video_generation') then
    raise exception using errcode = '22023', message = 'INVALID_ATTACHMENT_INTENT',
      detail = 'invalid_attachment_intent';
  end if;

  select r.* into v_run
  from public.agent_runs r
  where r.id = (p_attachment_intent->>'runId')::uuid
    and r.user_id = p_user_id and r.workspace_id = p_workspace_id
    and r.project_id = p_project_id and r.canvas_id = p_canvas_id
  for update;
  if not found then raise exception 'run_not_active'; end if;

  select a.* into v_attempt
  from public.agent_run_attempts a
  where a.run_id = v_run.id
    and a.attempt_id = v_run.current_attempt_id
    and a.attempt_id = (p_attachment_intent->>'attemptId')::uuid
    and a.status = 'running'
    and a.fencing_token = (p_attachment_intent->>'fencingToken')::bigint
    and a.lease_expires_at > now()
  for update;
  if not found then raise exception 'run_not_active'; end if;

  select * into v_effect from public.agent_effects e
  where e.run_id = v_run.id
    and e.logical_tool_call_id = p_attachment_intent->>'logicalToolCallId'
  for update;
  if not found or v_effect.status <> 'reserved'
     or v_effect.attempt_id <> v_attempt.attempt_id
     or v_effect.input_digest <> p_attachment_intent->>'inputDigest' then
    raise exception 'agent_effect_conflict';
  end if;

  insert into public.generated_asset_attachment_intents(
    id, job_id, effect_kind, workspace_id, project_id, canvas_id, session_id,
    user_id, media_type, placement_policy, run_id, attempt_id, fencing_token,
    logical_tool_call_id, input_digest
  ) values (
    v_intent_id, v_job_id, 'generated_asset_attached', p_workspace_id,
    p_project_id, p_canvas_id, p_session_id, p_user_id, v_media_type,
    p_attachment_intent->'placement', v_run.id, v_attempt.attempt_id,
    v_attempt.fencing_token, p_attachment_intent->>'logicalToolCallId',
    p_attachment_intent->>'inputDigest'
  ) on conflict (job_id, effect_kind) do nothing;

  select * into strict v_intent
  from public.generated_asset_attachment_intents
  where job_id = v_job_id and effect_kind = 'generated_asset_attached';
  if v_intent.id <> v_intent_id or v_intent.run_id <> v_run.id
     or v_intent.attempt_id <> v_attempt.attempt_id
     or v_intent.fencing_token <> v_attempt.fencing_token
     or v_intent.logical_tool_call_id <> p_attachment_intent->>'logicalToolCallId'
     or v_intent.input_digest <> p_attachment_intent->>'inputDigest'
     or v_intent.placement_policy <> p_attachment_intent->'placement' then
    raise exception using errcode = '23505', message = 'ATTACHMENT_INTENT_CONFLICT',
      detail = 'idempotency_conflict';
  end if;
  return v_submission || jsonb_build_object('attachment_intent', to_jsonb(v_intent));
end;
$$;

create function public.claim_generated_asset_attachment_intents(
  p_worker_id text, p_limit integer, p_lease_seconds integer,
  p_now timestamptz
) returns setof public.generated_asset_attachment_intents
language plpgsql security definer set search_path = '' as $$
begin
  if char_length(btrim(p_worker_id)) not between 1 and 100
     or p_limit not between 1 and 100 or p_lease_seconds not between 5 and 300 then
    raise exception using errcode = '22023', message = 'INVALID_INTENT_CLAIM',
      detail = 'invalid_request';
  end if;
  update public.generated_asset_attachment_intents i
  set state = 'failed', claim_owner = null, claim_expires_at = null,
      error_code = 'attachment_attempts_exhausted', updated_at = p_now
  where i.state = 'running' and i.claim_expires_at <= p_now
    and i.attempt_count >= 8;
  return query
  update public.generated_asset_attachment_intents i
  set state = 'running', claim_owner = btrim(p_worker_id),
      claim_expires_at = p_now + make_interval(secs => p_lease_seconds),
      claim_fencing_token = i.claim_fencing_token + 1,
      attempt_count = i.attempt_count + 1, updated_at = p_now
  where i.id in (
    select candidate.id
    from public.generated_asset_attachment_intents candidate
    where exists (
      select 1 from public.background_jobs terminal_job
      where terminal_job.id = candidate.job_id
        and terminal_job.status in ('succeeded', 'canceled', 'dead_letter')
    ) and (
      candidate.state in ('pending', 'retry_wait')
        and candidate.next_attempt_at <= p_now
        and candidate.attempt_count < 8
    ) or (
      candidate.state = 'running' and candidate.claim_expires_at <= p_now
        and candidate.attempt_count < 8
    )
    order by candidate.next_attempt_at, candidate.created_at
    limit p_limit
    for update skip locked
  )
  returning i.*;
end;
$$;

create function public.settle_generated_asset_attachment_intent(
  p_intent_id uuid, p_claim_fence bigint, p_outcome text,
  p_error_code text, p_next_attempt_at timestamptz
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_intent public.generated_asset_attachment_intents%rowtype;
  v_audit public.generated_asset_recovery_audits%rowtype;
begin
  select * into v_intent from public.generated_asset_attachment_intents
  where id = p_intent_id for update;
  if not found then raise exception using errcode = 'P0002',
    message = 'ATTACHMENT_INTENT_NOT_FOUND', detail = 'attachment_intent_not_found';
  end if;
  if v_intent.state <> 'running'
     or v_intent.claim_fencing_token <> p_claim_fence
     or v_intent.claim_expires_at <= now() then
    raise exception using errcode = 'P0001', message = 'STALE_ATTACHMENT_CLAIM',
      detail = 'stale_attachment_claim';
  end if;
  if p_outcome = 'retry_wait' and v_intent.attempt_count < 8 then
    if p_next_attempt_at is null or p_next_attempt_at <= now() then
      raise exception using errcode = '22023', message = 'INVALID_RETRY_TIME',
        detail = 'invalid_request';
    end if;
    update public.generated_asset_attachment_intents set state = 'retry_wait',
      claim_owner = null, claim_expires_at = null,
      next_attempt_at = p_next_attempt_at,
      error_code = left(coalesce(nullif(p_error_code, ''), 'attachment_retry'), 64),
      updated_at = now() where id = p_intent_id returning * into v_intent;
  elsif p_outcome in ('failed', 'retry_wait') then
    update public.generated_asset_attachment_intents set state = 'failed',
      claim_owner = null, claim_expires_at = null,
      error_code = left(coalesce(nullif(p_error_code, ''), 'attachment_failed'), 64),
      updated_at = now() where id = p_intent_id returning * into v_intent;
  elsif p_outcome = 'canceled' then
    update public.generated_asset_attachment_intents set state = 'canceled',
      claim_owner = null, claim_expires_at = null,
      error_code = left(coalesce(nullif(p_error_code, ''), 'generation_canceled'), 64),
      updated_at = now() where id = p_intent_id returning * into v_intent;
  else
    raise exception using errcode = '22023', message = 'INVALID_INTENT_OUTCOME',
      detail = 'invalid_request';
  end if;
  if v_intent.state in ('failed', 'canceled') then
    select * into v_audit from public.generated_asset_recovery_audits
    where intent_id = v_intent.id for update;
    if found then
      update public.generated_asset_recovery_audits
      set state = 'failed', result = null, error_code = v_intent.error_code,
        completed_at = now()
      where id = v_audit.id;
    end if;
  end if;
  return to_jsonb(v_intent);
end;
$$;

create function public.fulfill_generated_asset_attachment(
  p_intent_id uuid, p_claim_fence bigint, p_element_template jsonb,
  p_file_template jsonb, p_agent_attempt_id uuid, p_agent_fencing_token bigint
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_job public.background_jobs%rowtype;
  v_intent public.generated_asset_attachment_intents%rowtype;
  v_canvas public.canvases%rowtype;
  v_receipt public.job_effect_receipts%rowtype;
  v_asset public.asset_objects%rowtype;
  v_effect public.agent_effects%rowtype;
  v_attempt public.agent_run_attempts%rowtype;
  v_audit public.generated_asset_recovery_audits%rowtype;
  v_content jsonb;
  v_elements jsonb;
  v_files jsonb;
  v_element jsonb;
  v_file jsonb;
  v_element_id text;
  v_file_id text;
  v_asset_id uuid;
  v_x numeric;
  v_y numeric;
  v_result jsonb;
begin
  -- All attachment writers lock in this order: job, intent, canvas, receipt,
  -- attempt/effect, recovery audit. Keep the transaction free of I/O.
  select j.* into v_job from public.background_jobs j
  join public.generated_asset_attachment_intents i on i.job_id = j.id
  where i.id = p_intent_id for update of j;
  if not found then raise exception using errcode = 'P0002',
    message = 'ATTACHMENT_JOB_NOT_FOUND', detail = 'attachment_intent_not_found';
  end if;
  select * into v_intent from public.generated_asset_attachment_intents
  where id = p_intent_id for update;
  select * into v_canvas from public.canvases where id = v_intent.canvas_id for update;
  if not found then raise exception using errcode = 'P0002',
    message = 'ATTACHMENT_CANVAS_NOT_FOUND', detail = 'canvas_not_found';
  end if;
  select * into v_receipt from public.job_effect_receipts
  where job_id = v_job.id and effect_kind = v_intent.effect_kind for update;

  v_element_id := v_job.id::text;
  if found then
    if v_receipt.result->>'jobId' <> v_job.id::text
       or v_receipt.result->>'canvasId' <> v_canvas.id::text
       or v_receipt.result->>'elementId' <> v_element_id
       or jsonb_typeof(v_receipt.result->'canvasRevision') <> 'number' then
      raise exception using errcode = 'P0001', message = 'MALFORMED_ATTACHMENT_RECEIPT',
        detail = 'attachment_integrity_failure';
    end if;
    if v_intent.state <> 'attached' then
      update public.generated_asset_attachment_intents
      set state = 'attached', result = v_receipt.result, attached_at = now(),
        claim_owner = null, claim_expires_at = null, error_code = null,
        updated_at = now() where id = v_intent.id;
    end if;
    return v_receipt.result || jsonb_build_object('replayed', true);
  end if;

  if v_intent.state <> 'running'
     or v_intent.claim_fencing_token <> p_claim_fence
     or v_intent.claim_expires_at <= now() then
    raise exception using errcode = 'P0001', message = 'STALE_ATTACHMENT_CLAIM',
      detail = 'stale_attachment_claim';
  end if;
  if v_job.status <> 'succeeded' then
    raise exception using errcode = 'P0001', message = 'GENERATION_NOT_SUCCEEDED',
      detail = 'generation_not_succeeded';
  end if;
  if v_job.workspace_id <> v_intent.workspace_id
     or v_job.project_id is distinct from v_intent.project_id
     or v_job.canvas_id is distinct from v_intent.canvas_id
     or v_job.session_id is distinct from v_intent.session_id
     or v_job.created_by <> v_intent.user_id
     or (v_intent.media_type = 'image' and v_job.job_type <> 'image_generation')
     or (v_intent.media_type = 'video' and v_job.job_type <> 'video_generation') then
    raise exception using errcode = 'P0001', message = 'ATTACHMENT_SCOPE_MISMATCH',
      detail = 'attachment_integrity_failure';
  end if;

  begin v_asset_id := (v_job.result->>'asset_id')::uuid;
  exception when others then
    raise exception using errcode = 'P0001', message = 'MISSING_GENERATED_ASSET',
      detail = 'attachment_integrity_failure';
  end;
  select * into v_asset from public.asset_objects
  where id = v_asset_id and generation_job_id = v_job.id
    and workspace_id = v_intent.workspace_id
    and project_id = v_intent.project_id;
  if not found or (v_intent.media_type = 'image' and v_asset.mime_type not like 'image/%')
     or (v_intent.media_type = 'video' and v_asset.mime_type not like 'video/%') then
    raise exception using errcode = 'P0001', message = 'GENERATED_ASSET_MISMATCH',
      detail = 'attachment_integrity_failure';
  end if;
  if jsonb_typeof(p_element_template) <> 'object'
     or pg_column_size(p_element_template) > 65536
     or p_element_template->>'id' <> v_element_id then
    raise exception using errcode = '22023', message = 'INVALID_ELEMENT_TEMPLATE',
      detail = 'attachment_integrity_failure';
  end if;
  if v_intent.placement_policy->>'kind' = 'explicit' and (
      jsonb_typeof(p_element_template->'x') <> 'number'
      or jsonb_typeof(p_element_template->'y') <> 'number'
      or jsonb_typeof(p_element_template->'width') <> 'number'
      or jsonb_typeof(p_element_template->'height') <> 'number'
      or (p_element_template->>'x')::numeric
        <> (v_intent.placement_policy->>'x')::numeric
      or (p_element_template->>'y')::numeric
        <> (v_intent.placement_policy->>'y')::numeric
      or (p_element_template->>'width')::numeric
        <> (v_intent.placement_policy->>'width')::numeric
      or (p_element_template->>'height')::numeric
        <> (v_intent.placement_policy->>'height')::numeric
    ) then
    raise exception using errcode = '22023', message = 'INVALID_EXPLICIT_PLACEMENT',
      detail = 'attachment_integrity_failure';
  end if;
  v_file_id := v_element_id || '-file';
  if v_intent.media_type = 'image' and (
      jsonb_typeof(p_file_template) <> 'object'
      or pg_column_size(p_file_template) > 16384
      or p_file_template->>'id' <> v_file_id
      or p_file_template->>'assetId' <> v_asset.id::text
      or p_element_template->>'fileId' <> v_file_id
    ) then
    raise exception using errcode = '22023', message = 'INVALID_FILE_TEMPLATE',
      detail = 'attachment_integrity_failure';
  end if;
  if v_intent.media_type = 'video' and p_file_template is not null then
    raise exception using errcode = '22023', message = 'INVALID_VIDEO_FILE_TEMPLATE',
      detail = 'attachment_integrity_failure';
  end if;

  v_content := coalesce(v_canvas.content, '{}'::jsonb);
  v_elements := case when jsonb_typeof(v_content->'elements') = 'array'
    then v_content->'elements' else '[]'::jsonb end;
  v_files := case when jsonb_typeof(v_content->'files') = 'object'
    then v_content->'files' else '{}'::jsonb end;
  if exists(select 1 from jsonb_array_elements(v_elements) e
    where e->>'id' = v_element_id) or v_files ? v_file_id then
    raise exception using errcode = 'P0001', message = 'ATTACHMENT_ID_COLLISION',
      detail = 'attachment_integrity_failure';
  end if;

  if v_intent.placement_policy->>'kind' = 'explicit' then
    v_x := (v_intent.placement_policy->>'x')::numeric;
    v_y := (v_intent.placement_policy->>'y')::numeric;
  else
    select coalesce(max(
      (case when jsonb_typeof(e->'x') = 'number' then (e->>'x')::numeric else 0 end)
      + (case when jsonb_typeof(e->'width') = 'number' then (e->>'width')::numeric else 0 end)
    ), -80) + 80 into v_x from jsonb_array_elements(v_elements) e;
    v_y := 0;
  end if;
  v_element := p_element_template || jsonb_build_object(
    'id', v_element_id, 'x', v_x, 'y', v_y,
    'width', (v_intent.placement_policy->>'width')::numeric,
    'height', (v_intent.placement_policy->>'height')::numeric,
    'customData', coalesce(p_element_template->'customData', '{}'::jsonb)
      || jsonb_build_object('assetId', v_asset.id, 'generationJobId', v_job.id)
  );
  if v_intent.placement_policy->>'kind' = 'auto_right' then
    v_element := v_element || jsonb_build_object(
      'width', (p_element_template->>'width')::numeric,
      'height', (p_element_template->>'height')::numeric
    );
  end if;
  v_elements := v_elements || jsonb_build_array(v_element);
  if v_intent.media_type = 'image' then
    v_file := p_file_template || jsonb_build_object(
      'id', v_file_id, 'assetId', v_asset.id, 'mimeType', v_asset.mime_type
    );
    v_files := v_files || jsonb_build_object(v_file_id, v_file);
  end if;
  v_content := v_content || jsonb_build_object('elements', v_elements, 'files', v_files);
  update public.canvases set content = v_content, revision = revision + 1,
    updated_at = now() where id = v_canvas.id returning * into v_canvas;

  v_result := jsonb_build_object(
    'attachmentStatus', 'attached', 'jobId', v_job.id,
    'canvasId', v_canvas.id, 'elementId', v_element_id,
    'canvasRevision', v_canvas.revision
  );
  insert into public.job_effect_receipts(job_id, effect_kind, result)
  values (v_job.id, v_intent.effect_kind, v_result);
  insert into public.domain_outbox(
    aggregate_type, aggregate_id, aggregate_version, event_type, payload
  ) values ('canvas', v_canvas.id, v_canvas.revision, 'canvas.updated',
    jsonb_build_object('canvasId', v_canvas.id, 'revision', v_canvas.revision,
      'jobId', v_job.id, 'elementId', v_element_id,
      'effectKind', v_intent.effect_kind, 'source', 'generated_asset_attachment'));
  update public.generated_asset_attachment_intents set state = 'attached',
    result = v_result, attached_at = now(), claim_owner = null,
    claim_expires_at = null, error_code = null, updated_at = now()
  where id = v_intent.id;

  if v_intent.attempt_id is not null
     and p_agent_attempt_id = v_intent.attempt_id
     and p_agent_fencing_token = v_intent.fencing_token then
    select * into v_attempt from public.agent_run_attempts
    where attempt_id = v_intent.attempt_id for update;
    select * into v_effect from public.agent_effects
    where run_id = v_intent.run_id
      and logical_tool_call_id = v_intent.logical_tool_call_id for update;
    if v_attempt.status = 'running'
       and v_attempt.fencing_token = v_intent.fencing_token
       and v_attempt.lease_expires_at > now()
       and v_effect.status = 'reserved'
       and v_effect.input_digest = v_intent.input_digest then
      update public.agent_effects set status = 'completed', result = v_result,
        completed_at = now() where run_id = v_intent.run_id
          and logical_tool_call_id = v_intent.logical_tool_call_id;
    end if;
  end if;
  select * into v_audit from public.generated_asset_recovery_audits
  where intent_id = v_intent.id for update;
  if found then
    update public.generated_asset_recovery_audits set state = 'attached',
      result = v_result, error_code = null, completed_at = now()
    where id = v_audit.id;
  end if;
  return v_result || jsonb_build_object('replayed', false);
end;
$$;

create function public.retry_generated_asset_attachment(
  p_user_id uuid, p_canvas_id uuid, p_job_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_intent public.generated_asset_attachment_intents%rowtype;
  v_audit public.generated_asset_recovery_audits%rowtype;
begin
  select i.* into v_intent
  from public.generated_asset_attachment_intents i
  join public.background_jobs j on j.id = i.job_id
  join public.canvases c on c.id = i.canvas_id
  join public.projects p on p.id = c.project_id
  join public.workspace_members wm on wm.workspace_id = p.workspace_id
    and wm.user_id = p_user_id
  where i.job_id = p_job_id and i.canvas_id = p_canvas_id
    and i.user_id = p_user_id and j.created_by = p_user_id
  for update of i;
  if not found then raise exception using errcode = 'P0002',
    message = 'ATTACHMENT_NOT_FOUND', detail = 'attachment_intent_not_found';
  end if;
  if v_intent.state = 'attached' then return v_intent.result; end if;
  if v_intent.state <> 'failed' then return jsonb_build_object(
    'attachmentStatus', 'pending', 'jobId', v_intent.job_id,
    'canvasId', v_intent.canvas_id, 'state', v_intent.state);
  end if;
  insert into public.generated_asset_recovery_audits(
    user_id, canvas_id, job_id, effect_kind, intent_id
  ) values (p_user_id, p_canvas_id, p_job_id, v_intent.effect_kind, v_intent.id)
  on conflict (user_id, canvas_id, job_id, effect_kind) do nothing;
  select * into strict v_audit from public.generated_asset_recovery_audits
  where user_id = p_user_id and canvas_id = p_canvas_id
    and job_id = p_job_id and effect_kind = v_intent.effect_kind for update;
  update public.generated_asset_recovery_audits set state = 'pending',
    result = null, error_code = null, completed_at = null where id = v_audit.id;
  update public.generated_asset_attachment_intents set state = 'pending',
    next_attempt_at = now(), error_code = null, updated_at = now()
  where id = v_intent.id returning * into v_intent;
  return jsonb_build_object('attachmentStatus', 'pending',
    'jobId', v_intent.job_id, 'canvasId', v_intent.canvas_id,
    'state', v_intent.state);
end;
$$;

create function public.renew_agent_run_attempt(
  p_attempt_id uuid, p_fencing_token bigint, p_lease_owner text,
  p_lease_ms integer
) returns table(lease_expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
begin
  if p_lease_ms not between 5000 and 300000
     or char_length(btrim(p_lease_owner)) not between 1 and 100 then
    raise exception 'attempt_lease_invalid';
  end if;
  update public.agent_run_attempts a set
    lease_expires_at = now() + make_interval(secs => p_lease_ms::double precision / 1000)
  where a.attempt_id = p_attempt_id and a.status = 'running'
    and a.fencing_token = p_fencing_token
    and a.lease_owner = btrim(p_lease_owner) and a.lease_expires_at > now()
  returning a.lease_expires_at into lease_expires_at;
  if not found then raise exception 'run_not_active'; end if;
  return next;
end;
$$;

create function public.recover_expired_agent_runs(
  p_now timestamptz, p_grace_ms integer, p_limit integer
) returns setof jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_run public.agent_runs%rowtype;
  v_attempt public.agent_run_attempts%rowtype;
  v_completed_at timestamptz;
begin
  if p_grace_ms not between 0 and 3600000 or p_limit not between 1 and 100 then
    raise exception 'expired_run_recovery_invalid';
  end if;
  for v_run in
    select r.* from public.agent_runs r
    join public.agent_run_attempts a on a.run_id = r.id
      and a.attempt_id = r.current_attempt_id
    where r.status = 'running' and a.status = 'running'
      and a.lease_expires_at + make_interval(
        secs => p_grace_ms::double precision / 1000) <= p_now
    order by a.lease_expires_at, r.id
    limit p_limit for update of r skip locked
  loop
    select * into v_attempt from public.agent_run_attempts a
    where a.run_id = v_run.id and a.attempt_id = v_run.current_attempt_id
    for update;
    if v_attempt.status <> 'running'
       or v_attempt.lease_expires_at + make_interval(
         secs => p_grace_ms::double precision / 1000) > p_now then
      continue;
    end if;
    v_completed_at := clock_timestamp();
    update public.agent_runs set status = 'failed', completed_at = v_completed_at,
      error_code = 'agent_attempt_lease_expired',
      error_message = 'The Agent run stopped before completion.'
    where id = v_run.id;
    update public.agent_run_attempts set status = 'failed',
      completed_at = v_completed_at, lease_owner = null, lease_expires_at = null
    where run_id = v_run.id and attempt_id = v_attempt.attempt_id;
    insert into public.domain_outbox(
      aggregate_type, aggregate_id, aggregate_version, event_type, payload
    ) values ('agent_run', v_run.id, v_attempt.fencing_token,
      'agent.run.failed', jsonb_build_object(
        'runId', v_run.id, 'attemptId', v_attempt.attempt_id,
        'userId', v_run.user_id, 'canvasId', v_run.canvas_id,
        'error', jsonb_build_object('code', 'agent_attempt_lease_expired',
          'message', 'The Agent run stopped before completion.')));
    return next jsonb_build_object('runId', v_run.id,
      'attemptId', v_attempt.attempt_id, 'status', 'failed');
  end loop;
end;
$$;

revoke all on function public.submit_generation_job(
  uuid,uuid,text,text,public.background_job_type,jsonb,integer,text,
  uuid,uuid,uuid,text,jsonb) from public, anon, authenticated;
revoke all on function public.claim_generated_asset_attachment_intents(
  text,integer,integer,timestamptz) from public, anon, authenticated;
revoke all on function public.settle_generated_asset_attachment_intent(
  uuid,bigint,text,text,timestamptz) from public, anon, authenticated;
revoke all on function public.fulfill_generated_asset_attachment(
  uuid,bigint,jsonb,jsonb,uuid,bigint) from public, anon, authenticated;
revoke all on function public.retry_generated_asset_attachment(uuid,uuid,uuid)
  from public, anon, authenticated;
revoke all on function public.renew_agent_run_attempt(uuid,bigint,text,integer)
  from public, anon, authenticated;
revoke all on function public.recover_expired_agent_runs(timestamptz,integer,integer)
  from public, anon, authenticated;
grant execute on function public.submit_generation_job(
  uuid,uuid,text,text,public.background_job_type,jsonb,integer,text,
  uuid,uuid,uuid,text,jsonb) to service_role;
grant execute on function public.claim_generated_asset_attachment_intents(
  text,integer,integer,timestamptz) to service_role;
grant execute on function public.settle_generated_asset_attachment_intent(
  uuid,bigint,text,text,timestamptz) to service_role;
grant execute on function public.fulfill_generated_asset_attachment(
  uuid,bigint,jsonb,jsonb,uuid,bigint) to service_role;
grant execute on function public.retry_generated_asset_attachment(uuid,uuid,uuid)
  to service_role;
grant execute on function public.renew_agent_run_attempt(uuid,bigint,text,integer)
  to service_role;
grant execute on function public.recover_expired_agent_runs(timestamptz,integer,integer)
  to service_role;
