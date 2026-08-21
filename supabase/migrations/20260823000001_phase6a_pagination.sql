-- Phase 6A server-state pagination and auditable legacy message canonicalization.

alter table public.chat_messages
  add column if not exists superseded_by uuid;

comment on column public.chat_messages.superseded_by is
  'Server-managed canonical message id. Non-null rows remain stored for audit but are excluded from canonical reads.';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.chat_messages'::regclass
      and conname = 'chat_messages_superseded_by_fkey'
  ) then
    alter table public.chat_messages
      add constraint chat_messages_superseded_by_fkey
      foreign key (superseded_by)
      references public.chat_messages(id)
      on delete restrict;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.chat_messages'::regclass
      and conname = 'chat_messages_superseded_by_not_self_check'
  ) then
    alter table public.chat_messages
      add constraint chat_messages_superseded_by_not_self_check
      check (superseded_by is null or superseded_by <> id);
  end if;
end
$$;

-- Authenticated message writes remain append-only. RLS additionally prevents
-- clients from injecting a canonicalization marker during insert.
revoke update (superseded_by) on public.chat_messages from anon, authenticated;

drop policy if exists chat_messages_insert on public.chat_messages;
create policy chat_messages_insert on public.chat_messages
  for insert
  to authenticated
  with check (
    superseded_by is null
    and exists (
      select 1
      from public.chat_sessions cs
      join public.canvases c on c.id = cs.canvas_id
      join public.projects p on p.id = c.project_id
      join public.workspace_members wm on wm.workspace_id = p.workspace_id
      where cs.id = chat_messages.session_id
        and wm.user_id = (select auth.uid())
    )
  );

create or replace function private.backfill_chat_message_supersessions()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_affected integer;
begin
  with source as (
    select
      m.id,
      m.session_id,
      m.role,
      m.content,
      m.tool_activities,
      m.content_blocks,
      m.created_at,
      lag(m.role) over message_order as previous_role,
      lag(m.content) over message_order as previous_content
    from public.chat_messages m
    window message_order as (
      partition by m.session_id
      order by m.created_at, m.id
    )
  ), boundaries as (
    select
      source.*,
      case
        when role = 'assistant'
          and previous_role = 'assistant'
          and content is not distinct from previous_content
        then 0
        else 1
      end as starts_group
    from source
  ), grouped as (
    select
      boundaries.*,
      sum(starts_group) over (
        partition by session_id
        order by created_at, id
        rows between unbounded preceding and current row
      ) as duplicate_group
    from boundaries
  ), effective_blocks as (
    select
      grouped.*,
      case
        when jsonb_typeof(content_blocks) = 'array'
          and jsonb_array_length(content_blocks) > 0
        then content_blocks
        else
          case
            when content <> ''
            then jsonb_build_array(
              jsonb_build_object('type', 'text', 'text', content)
            )
            else '[]'::jsonb
          end
          || coalesce(
            (
              select jsonb_agg(
                jsonb_build_object('type', 'tool') || activity.value
                order by activity.ordinality
              )
              from jsonb_array_elements(
                case
                  when jsonb_typeof(tool_activities) = 'array'
                  then tool_activities
                  else '[]'::jsonb
                end
              ) with ordinality as activity(value, ordinality)
            ),
            '[]'::jsonb
          )
      end as blocks
    from grouped
  ), scored as (
    select
      effective_blocks.*,
      (
        select count(*)::integer
        from jsonb_array_elements(blocks) as block(value)
        where block.value ->> 'type' = 'tool'
          and block.value ->> 'status' in ('completed', 'failed')
      ) as terminal_tool_count,
      (
        select coalesce(sum(
          case
            when block.value ->> 'type' = 'tool'
              and jsonb_typeof(block.value -> 'artifacts') = 'array'
            then jsonb_array_length(block.value -> 'artifacts')
            else 0
          end
        ), 0)::integer
        from jsonb_array_elements(blocks) as block(value)
      ) as artifact_count,
      jsonb_array_length(blocks) as block_count
    from effective_blocks
    where role = 'assistant'
  ), ranked as (
    select
      id,
      count(*) over (
        partition by session_id, duplicate_group
      ) as group_size,
      first_value(id) over (
        partition by session_id, duplicate_group
        order by
          terminal_tool_count desc,
          artifact_count desc,
          block_count desc,
          id
      ) as winner_id
    from scored
  ), desired as (
    select
      id,
      case
        when group_size > 1 and id <> winner_id then winner_id
        else null
      end as superseded_by
    from ranked
  ), marked as (
    update public.chat_messages message
    set superseded_by = desired.superseded_by
    from desired
    where message.id = desired.id
      and message.superseded_by is distinct from desired.superseded_by
    returning message.id
  )
  select count(*)::integer
  into v_affected
  from marked;

  raise log 'marker=phase6a_chat_message_supersession_backfill affected_count=%',
    v_affected;
  return v_affected;
end;
$$;

revoke all on function private.backfill_chat_message_supersessions()
  from public, anon, authenticated;
grant usage on schema private to service_role;
grant execute on function private.backfill_chat_message_supersessions()
  to service_role;

select private.backfill_chat_message_supersessions();

create index if not exists projects_workspace_active_updated_at_id_idx
  on public.projects (workspace_id, updated_at desc, id desc)
  where archived_at is null;

-- brand_kits is currently user-scoped; it has no workspace_id column.
create index if not exists brand_kits_user_created_at_id_idx
  on public.brand_kits (user_id, created_at asc, id asc);

create index if not exists credit_transactions_workspace_created_at_id_idx
  on public.credit_transactions (workspace_id, created_at desc, id desc);

create index if not exists chat_sessions_canvas_updated_at_id_idx
  on public.chat_sessions (canvas_id, updated_at desc, id desc);

create index if not exists chat_messages_session_canonical_created_at_id_idx
  on public.chat_messages (session_id, created_at desc, id desc)
  where superseded_by is null;

create index if not exists chat_messages_superseded_by_idx
  on public.chat_messages (superseded_by)
  where superseded_by is not null;
