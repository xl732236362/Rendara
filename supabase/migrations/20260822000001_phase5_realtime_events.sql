-- Phase 5: durable canvas realtime events and attempt lease renewal.

create table public.realtime_canvas_events (
  event_id uuid primary key,
  canvas_id uuid not null references public.canvases(id) on delete cascade,
  canvas_seq bigint not null check (canvas_seq > 0),
  event_type text not null check (char_length(event_type) between 1 and 100),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (canvas_id, canvas_seq)
);

create index realtime_canvas_events_replay_idx
  on public.realtime_canvas_events(canvas_id, canvas_seq);
create index realtime_canvas_events_retention_idx
  on public.realtime_canvas_events(created_at);

create table public.realtime_canvas_cursors (
  canvas_id uuid primary key references public.canvases(id) on delete cascade,
  last_seq bigint not null default 0 check (last_seq >= 0),
  updated_at timestamptz not null default now()
);

alter table public.realtime_canvas_cursors enable row level security;
revoke all on table public.realtime_canvas_cursors from anon, authenticated;
grant select, insert, update, delete on table public.realtime_canvas_cursors to service_role;

alter table public.realtime_canvas_events enable row level security;
revoke all on table public.realtime_canvas_events from anon, authenticated;
grant select, insert, update, delete on table public.realtime_canvas_events to service_role;

create or replace function public.append_realtime_canvas_event(
  p_event_id uuid,
  p_canvas_id uuid,
  p_event_type text,
  p_payload jsonb,
  p_occurred_at timestamptz default now()
) returns table(canvas_seq bigint, inserted boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_existing public.realtime_canvas_events%rowtype;
  v_seq bigint;
begin
  if p_event_id is null or p_canvas_id is null
     or p_event_type is null or char_length(btrim(p_event_type)) = 0
     or p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'realtime_event_invalid';
  end if;

  select * into v_existing
  from public.realtime_canvas_events
  where event_id = p_event_id;
  if found then
    if v_existing.canvas_id <> p_canvas_id
       or v_existing.event_type <> p_event_type
       or v_existing.payload <> p_payload then
      raise exception 'realtime_event_conflict';
    end if;
    return query select v_existing.canvas_seq, false;
    return;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('realtime-canvas:' || p_canvas_id::text, 0));
  -- Recheck after serialization so concurrent retries do not consume a cursor
  -- before discovering that the event ID was already committed.
  select * into v_existing
  from public.realtime_canvas_events
  where event_id = p_event_id;
  if found then
    if v_existing.canvas_id <> p_canvas_id
       or v_existing.event_type <> p_event_type
       or v_existing.payload <> p_payload then
      raise exception 'realtime_event_conflict';
    end if;
    return query select v_existing.canvas_seq, false;
    return;
  end if;

  insert into public.realtime_canvas_cursors(canvas_id)
  values (p_canvas_id)
  on conflict (canvas_id) do nothing;
  select last_seq + 1 into v_seq
  from public.realtime_canvas_cursors
  where canvas_id = p_canvas_id
  for update;
  update public.realtime_canvas_cursors
  set last_seq = v_seq, updated_at = now()
  where canvas_id = p_canvas_id;

  insert into public.realtime_canvas_events(
    event_id, canvas_id, canvas_seq, event_type, payload, occurred_at
  ) values (
    p_event_id, p_canvas_id, v_seq, btrim(p_event_type), p_payload,
    coalesce(p_occurred_at, now())
  );

  perform pg_notify(
    'loomic_realtime_canvas',
    json_build_object(
      'canvasId', p_canvas_id,
      'eventId', p_event_id,
      'seq', v_seq
    )::text
  );

  return query select v_seq, true;
exception
  when unique_violation then
    select * into v_existing from public.realtime_canvas_events
    where event_id = p_event_id;
    if found then
      return query select v_existing.canvas_seq, false;
      return;
    end if;
    raise;
end;
$$;

create or replace function public.read_realtime_canvas_events(
  p_canvas_id uuid,
  p_after_seq bigint default 0,
  p_limit integer default 500
) returns setof public.realtime_canvas_events
language sql security definer set search_path = '' as $$
  select e.*
  from public.realtime_canvas_events e
  where e.canvas_id = p_canvas_id
    and e.canvas_seq > greatest(coalesce(p_after_seq, 0), 0)
  order by e.canvas_seq
  limit least(greatest(coalesce(p_limit, 500), 1), 500);
$$;

create or replace function public.get_realtime_canvas_replay_status(
  p_canvas_id uuid,
  p_after_seq bigint default 0
) returns table(
  earliest_seq bigint,
  latest_seq bigint,
  latest_revision bigint,
  gap boolean
)
language sql security definer set search_path = '' as $$
  with bounds as (
    select
      (select min(e.canvas_seq) from public.realtime_canvas_events e
       where e.canvas_id = p_canvas_id) as earliest_seq,
      coalesce((select c.last_seq from public.realtime_canvas_cursors c
                where c.canvas_id = p_canvas_id), 0) as latest_seq
  )
  select b.earliest_seq, b.latest_seq,
    (select case
       when jsonb_typeof(e.payload -> 'revision') = 'number'
       then (e.payload ->> 'revision')::bigint
       else null
     end
     from public.realtime_canvas_events e
     where e.canvas_id = p_canvas_id
     order by e.canvas_seq desc
     limit 1) as latest_revision,
    greatest(coalesce(p_after_seq, 0), 0) > 0
      and b.latest_seq > greatest(coalesce(p_after_seq, 0), 0)
      and (b.earliest_seq is null
        or b.earliest_seq > greatest(coalesce(p_after_seq, 0), 0) + 1) as gap
  from bounds b;
$$;

create or replace function public.prune_realtime_canvas_events(
  p_before timestamptz,
  p_keep_per_canvas integer default 5000
) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_deleted integer;
begin
  if p_before is null or p_keep_per_canvas not between 1 and 100000 then
    raise exception 'realtime_retention_invalid';
  end if;

  delete from public.realtime_canvas_events e
  where e.created_at < p_before
    and e.canvas_seq <= coalesce((
      select c.last_seq - p_keep_per_canvas
      from public.realtime_canvas_cursors c
      where c.canvas_id = e.canvas_id
    ), -1);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.append_realtime_canvas_event(uuid,uuid,text,jsonb,timestamptz)
  from public, anon, authenticated;
grant execute on function public.append_realtime_canvas_event(uuid,uuid,text,jsonb,timestamptz)
  to service_role;
revoke all on function public.read_realtime_canvas_events(uuid,bigint,integer)
  from public, anon, authenticated;
grant execute on function public.read_realtime_canvas_events(uuid,bigint,integer)
  to service_role;
revoke all on function public.get_realtime_canvas_replay_status(uuid,bigint)
  from public, anon, authenticated;
grant execute on function public.get_realtime_canvas_replay_status(uuid,bigint)
  to service_role;
revoke all on function public.prune_realtime_canvas_events(timestamptz,integer)
  from public, anon, authenticated;
grant execute on function public.prune_realtime_canvas_events(timestamptz,integer)
  to service_role;
