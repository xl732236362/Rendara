create function public.generated_asset_attachment_status_json(
  p_intent public.generated_asset_attachment_intents
) returns jsonb
language sql stable
set search_path = ''
as $$
  select case
    when p_intent.state = 'attached' then jsonb_build_object(
      'attachmentStatus', 'attached',
      'jobId', p_intent.job_id,
      'elementId', p_intent.result ->> 'elementId',
      'canvasRevision', (p_intent.result ->> 'canvasRevision')::bigint
    )
    when p_intent.state in ('failed', 'canceled') then jsonb_build_object(
      'attachmentStatus', 'not_attached',
      'jobId', p_intent.job_id,
      'recovery', jsonb_build_object(
        'kind', 'attach_generated_asset',
        'jobId', p_intent.job_id,
        'canvasId', p_intent.canvas_id
      ),
      'error', jsonb_build_object(
        'code', coalesce(p_intent.error_code, 'generated_asset_not_attached'),
        'message', 'Generated media was not attached.',
        'retryable', p_intent.state = 'failed'
      )
    )
    else jsonb_build_object(
      'attachmentStatus', 'pending',
      'jobId', p_intent.job_id,
      'recovery', jsonb_build_object(
        'kind', 'watch_generated_asset',
        'jobId', p_intent.job_id,
        'canvasId', p_intent.canvas_id
      ),
      'error', jsonb_build_object(
        'code', 'generated_asset_pending',
        'message', 'Generated media is still being attached.',
        'retryable', true
      )
    )
  end;
$$;

create function public.get_generated_asset_attachment_status(
  p_user_id uuid,
  p_workspace_id uuid,
  p_canvas_id uuid,
  p_job_id uuid
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_intent public.generated_asset_attachment_intents%rowtype;
begin
  select i.* into v_intent
  from public.generated_asset_attachment_intents i
  join public.background_jobs j on j.id = i.job_id
  join public.canvases c on c.id = i.canvas_id
  join public.projects p on p.id = c.project_id
  join public.workspace_members wm
    on wm.workspace_id = p.workspace_id and wm.user_id = p_user_id
  where i.job_id = p_job_id
    and i.canvas_id = p_canvas_id
    and i.workspace_id = p_workspace_id
    and p.workspace_id = p_workspace_id
    and i.user_id = p_user_id
    and j.created_by = p_user_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'ATTACHMENT_NOT_FOUND',
      detail = 'attachment_intent_not_found';
  end if;
  return public.generated_asset_attachment_status_json(v_intent);
end;
$$;

create function public.list_generated_asset_attachment_statuses(
  p_user_id uuid,
  p_workspace_id uuid,
  p_canvas_id uuid,
  p_session_id uuid,
  p_limit integer default 100
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'ATTACHMENT_LIMIT_INVALID';
  end if;
  select coalesce(jsonb_agg(public.generated_asset_attachment_status_json(q.i)
    order by (q.i).created_at), '[]'::jsonb)
  into v_result
  from (
    select i
    from public.generated_asset_attachment_intents i
    join public.background_jobs j on j.id = i.job_id
    join public.canvases c on c.id = i.canvas_id
    join public.projects p on p.id = c.project_id
    join public.workspace_members wm
      on wm.workspace_id = p.workspace_id and wm.user_id = p_user_id
    where i.canvas_id = p_canvas_id
      and i.session_id = p_session_id
      and i.workspace_id = p_workspace_id
      and p.workspace_id = p_workspace_id
      and i.user_id = p_user_id
      and j.created_by = p_user_id
      and i.state in ('pending', 'running', 'retry_wait', 'failed')
    order by i.created_at
    limit p_limit
  ) q;
  return v_result;
end;
$$;

create table public.generated_asset_attachment_workers (
  worker_id text primary key,
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null,
  constraint generated_asset_attachment_worker_id_length
    check (char_length(btrim(worker_id)) between 1 and 100)
);

alter table public.generated_asset_attachment_workers enable row level security;
alter table public.generated_asset_attachment_workers force row level security;
revoke all on table public.generated_asset_attachment_workers
  from public, anon, authenticated;
grant select, insert, update, delete
  on table public.generated_asset_attachment_workers to service_role;

create function public.heartbeat_generated_asset_attachment_worker(
  p_worker_id text,
  p_now timestamptz default now()
) returns boolean
language plpgsql security definer
set search_path = ''
as $$
begin
  if char_length(btrim(p_worker_id)) not between 1 and 100 then
    raise exception using errcode = '22023', message = 'WORKER_ID_INVALID';
  end if;
  insert into public.generated_asset_attachment_workers(
    worker_id, started_at, last_seen_at
  ) values (p_worker_id, p_now, p_now)
  on conflict (worker_id) do update set last_seen_at = excluded.last_seen_at;
  return true;
end;
$$;

create function public.generated_asset_attachment_infrastructure_ready(
  p_now timestamptz default now(),
  p_max_heartbeat_age_seconds integer default 30
) returns boolean
language plpgsql security definer
set search_path = ''
as $$
begin
  if p_max_heartbeat_age_seconds not between 5 and 300 then
    raise exception using errcode = '22023', message = 'HEARTBEAT_AGE_INVALID';
  end if;
  return exists (
    select 1 from public.generated_asset_attachment_workers
    where last_seen_at >= p_now - make_interval(secs => p_max_heartbeat_age_seconds)
  );
end;
$$;

revoke all on function public.generated_asset_attachment_status_json(
  public.generated_asset_attachment_intents
) from public, anon, authenticated;
revoke all on function public.get_generated_asset_attachment_status(
  uuid, uuid, uuid, uuid
) from public, anon, authenticated;
revoke all on function public.list_generated_asset_attachment_statuses(
  uuid, uuid, uuid, uuid, integer
) from public, anon, authenticated;
revoke all on function public.heartbeat_generated_asset_attachment_worker(
  text, timestamptz
) from public, anon, authenticated;
revoke all on function public.generated_asset_attachment_infrastructure_ready(
  timestamptz, integer
) from public, anon, authenticated;

grant execute on function public.get_generated_asset_attachment_status(
  uuid, uuid, uuid, uuid
) to service_role;
grant execute on function public.list_generated_asset_attachment_statuses(
  uuid, uuid, uuid, uuid, integer
) to service_role;
grant execute on function public.heartbeat_generated_asset_attachment_worker(
  text, timestamptz
) to service_role;
grant execute on function public.generated_asset_attachment_infrastructure_ready(
  timestamptz, integer
) to service_role;
