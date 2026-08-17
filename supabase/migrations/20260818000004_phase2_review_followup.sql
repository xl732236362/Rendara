-- Follow-up from independent review: cancellation must win before an external
-- effect starts, and every generation outbox event must identify its user.

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

  select * into v_attempt from public.generation_effect_attempts
  where job_id = p_job_id for update;
  if found then
    if v_attempt.state = 'completed' then
      return jsonb_build_object('kind', 'completed', 'result', v_attempt.result);
    end if;
    if v_attempt.state = 'started' and v_attempt.lease_token = p_lease_token then
      return jsonb_build_object('kind', 'started', 'replayed', true);
    end if;
    return jsonb_build_object('kind', 'ambiguous');
  end if;

  if v_job.status = 'cancel_requested' then
    return jsonb_build_object('kind', 'canceled');
  end if;
  insert into public.generation_effect_attempts (job_id, lease_token, state)
  values (p_job_id, p_lease_token, 'started');
  return jsonb_build_object('kind', 'started', 'replayed', false);
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
  select * into v_job from public.background_jobs
  where id = p_job_id and created_by = v_user_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'JOB_NOT_FOUND', detail = 'job_not_found'; end if;
  if v_job.status = 'canceled' then return jsonb_build_object('job', to_jsonb(v_job), 'replayed', true); end if;
  if v_job.status in ('succeeded', 'dead_letter') then
    raise exception using errcode = 'P0001', message = 'JOB_ALREADY_TERMINAL', detail = 'job_already_terminal';
  end if;
  update public.background_jobs
  set status = case when v_job.status in ('queued', 'failed') then 'canceled'::public.background_job_status
                    else 'cancel_requested'::public.background_job_status end,
      transition_version = transition_version + 1,
      canceled_at = case when v_job.status in ('queued', 'failed') then now() else canceled_at end
  where id = p_job_id returning * into v_job;
  if v_job.status = 'canceled' then
    insert into public.domain_outbox (aggregate_type, aggregate_id, aggregate_version, event_type, payload)
    values ('generation_job', v_job.id, v_job.transition_version, 'generation.job.canceled',
      jsonb_build_object('jobId', v_job.id, 'workspaceId', v_job.workspace_id, 'userId', v_job.created_by));
  end if;
  return jsonb_build_object('job', to_jsonb(v_job), 'replayed', false);
end;
$$;

-- Backfill unpublished rows created before generation events carried userId.
update public.domain_outbox o
set payload = o.payload || jsonb_build_object('userId', j.created_by)
from public.background_jobs j
where o.aggregate_type = 'generation_job'
  and o.aggregate_id = j.id
  and o.published_at is null
  and not (o.payload ? 'userId');

