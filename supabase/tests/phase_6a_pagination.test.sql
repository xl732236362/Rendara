begin;

create extension if not exists pgtap with schema extensions;

select plan(37);

select has_column(
  'public', 'chat_messages', 'superseded_by',
  'chat messages expose the server-managed supersession marker'
);
select col_type_is(
  'public', 'chat_messages', 'superseded_by', 'uuid',
  'supersession markers use UUID message identifiers'
);
select is(
  (
    select is_nullable
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'chat_messages'
      and column_name = 'superseded_by'
  ),
  'YES',
  'supersession markers are nullable for canonical messages'
);
select is(
  (
    select c.confdeltype::text
    from pg_constraint c
    where c.conrelid = 'public.chat_messages'::regclass
      and c.contype = 'f'
      and c.conname = 'chat_messages_superseded_by_fkey'
  ),
  'r',
  'deleting a canonical winner is restricted while audit rows reference it'
);
select ok(
  exists (
    select 1
    from pg_constraint c
    where c.conrelid = 'public.chat_messages'::regclass
      and c.contype = 'c'
      and c.conname = 'chat_messages_superseded_by_not_self_check'
      and pg_get_constraintdef(c.oid) =
        'CHECK (((superseded_by IS NULL) OR (superseded_by <> id)))'
  ),
  'a chat message cannot supersede itself'
);

select ok(
  not has_table_privilege('authenticated', 'public.chat_messages', 'update'),
  'authenticated clients retain no table-level message update grant'
);
select ok(
  not has_column_privilege(
    'authenticated', 'public.chat_messages', 'superseded_by', 'update'
  ),
  'authenticated clients cannot update the server-managed marker'
);
select ok(
  to_regprocedure('private.backfill_chat_message_supersessions()') is not null,
  'the audited maintenance backfill boundary exists'
);
select ok(
  not has_function_privilege(
    'authenticated', 'private.backfill_chat_message_supersessions()', 'execute'
  ),
  'authenticated clients cannot execute the maintenance backfill'
);
select ok(
  has_schema_privilege('service_role', 'private', 'usage')
    and has_function_privilege(
      'service_role', 'private.backfill_chat_message_supersessions()', 'execute'
    ),
  'service role can reach the controlled maintenance backfill'
);

select is(
  pg_get_indexdef(to_regclass('public.projects_workspace_active_updated_at_id_idx')),
  'CREATE INDEX projects_workspace_active_updated_at_id_idx ON public.projects USING btree (workspace_id, updated_at DESC, id DESC) WHERE (archived_at IS NULL)',
  'active project pagination has a deterministic workspace cursor index'
);
select is(
  pg_get_indexdef(to_regclass('public.brand_kits_user_created_at_id_idx')),
  'CREATE INDEX brand_kits_user_created_at_id_idx ON public.brand_kits USING btree (user_id, created_at, id)',
  'brand kit pagination follows its actual user ownership column'
);
select is(
  pg_get_indexdef(to_regclass('public.credit_transactions_workspace_created_at_id_idx')),
  'CREATE INDEX credit_transactions_workspace_created_at_id_idx ON public.credit_transactions USING btree (workspace_id, created_at DESC, id DESC)',
  'credit transaction pagination has a deterministic workspace cursor index'
);
select is(
  pg_get_indexdef(to_regclass('public.chat_sessions_canvas_updated_at_id_idx')),
  'CREATE INDEX chat_sessions_canvas_updated_at_id_idx ON public.chat_sessions USING btree (canvas_id, updated_at DESC, id DESC)',
  'chat session pagination has a deterministic canvas cursor index'
);
select is(
  pg_get_indexdef(to_regclass('public.chat_messages_session_canonical_created_at_id_idx')),
  'CREATE INDEX chat_messages_session_canonical_created_at_id_idx ON public.chat_messages USING btree (session_id, created_at DESC, id DESC) WHERE (superseded_by IS NULL)',
  'canonical chat pagination excludes superseded audit rows in the index'
);
select is(
  pg_get_indexdef(to_regclass('public.chat_messages_superseded_by_idx')),
  'CREATE INDEX chat_messages_superseded_by_idx ON public.chat_messages USING btree (superseded_by) WHERE (superseded_by IS NOT NULL)',
  'the self-FK reference side is indexed for delete checks and audits'
);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '60000000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
  'phase6a-pagination@example.test', '', now(),
  '{"provider":"email","providers":["email"]}', '{}', now(), now()
);

create temporary table phase6a_fixture(
  workspace_id uuid,
  project_id uuid,
  canvas_id uuid,
  session_a_id uuid,
  session_b_id uuid
);
insert into phase6a_fixture
select
  id,
  '60000000-0000-4000-8000-000000000002',
  '60000000-0000-4000-8000-000000000003',
  '60000000-0000-4000-8000-000000000004',
  '60000000-0000-4000-8000-000000000005'
from public.workspaces
where owner_user_id = '60000000-0000-4000-8000-000000000001';

insert into public.projects(id, workspace_id, name, slug, created_by)
select project_id, workspace_id, 'Phase 6A', 'phase-6a-pagination',
  '60000000-0000-4000-8000-000000000001'
from phase6a_fixture;
insert into public.canvases(id, project_id, name, created_by)
select canvas_id, project_id, 'Phase 6A canvas',
  '60000000-0000-4000-8000-000000000001'
from phase6a_fixture;
insert into public.chat_sessions(id, canvas_id, title, created_by)
select session_a_id, canvas_id, 'Primary fixture',
  '60000000-0000-4000-8000-000000000001'::uuid
from phase6a_fixture
union all
select session_b_id, canvas_id, 'Cross-session fixture',
  '60000000-0000-4000-8000-000000000001'::uuid
from phase6a_fixture;

-- Legacy tool_activities exercise the same synthesized blocks used by
-- chat-service.ts when content_blocks is absent.
insert into public.chat_messages(
  id, session_id, role, content, tool_activities, content_blocks, created_at
)
select id, session_a_id, role, content, tool_activities, content_blocks, created_at
from phase6a_fixture
cross join (values
  ('60000000-0000-4000-8000-000000000101'::uuid, 'assistant', 'terminal',
    '[{"toolCallId":"t1","toolName":"generate","status":"running"}]'::jsonb,
    null::jsonb, '2026-08-22 00:01:00+00'::timestamptz),
  ('60000000-0000-4000-8000-000000000102'::uuid, 'assistant', 'terminal',
    '[{"toolCallId":"t1","toolName":"generate","status":"completed"}]'::jsonb,
    null::jsonb, '2026-08-22 00:02:00+00'::timestamptz),
  ('60000000-0000-4000-8000-000000000103'::uuid, 'user', 'separator-1',
    null::jsonb, '[{"type":"text","text":"separator-1"}]'::jsonb,
    '2026-08-22 00:03:00+00'::timestamptz),
  ('60000000-0000-4000-8000-000000000111'::uuid, 'assistant', 'artifact',
    null::jsonb, '[{"type":"tool","status":"completed"}]'::jsonb,
    '2026-08-22 00:04:00+00'::timestamptz),
  ('60000000-0000-4000-8000-000000000112'::uuid, 'assistant', 'artifact',
    null::jsonb, '[{"type":"tool","status":"completed","artifacts":[{"type":"image"}]}]'::jsonb,
    '2026-08-22 00:05:00+00'::timestamptz),
  ('60000000-0000-4000-8000-000000000113'::uuid, 'user', 'separator-2',
    null::jsonb, null::jsonb, '2026-08-22 00:06:00+00'::timestamptz),
  ('60000000-0000-4000-8000-000000000121'::uuid, 'assistant', 'blocks',
    null::jsonb, '[{"type":"text","text":"blocks"}]'::jsonb,
    '2026-08-22 00:07:00+00'::timestamptz),
  ('60000000-0000-4000-8000-000000000122'::uuid, 'assistant', 'blocks',
    null::jsonb, '[{"type":"text","text":"blocks"},{"type":"thinking","thinking":"detail"}]'::jsonb,
    '2026-08-22 00:08:00+00'::timestamptz),
  ('60000000-0000-4000-8000-000000000123'::uuid, 'user', 'separator-3',
    null::jsonb, null::jsonb, '2026-08-22 00:09:00+00'::timestamptz),
  ('60000000-0000-4000-8000-000000000142'::uuid, 'assistant', 'uuid-tie',
    null::jsonb, '[{"type":"text","text":"uuid-tie"}]'::jsonb,
    '2026-08-22 00:10:00+00'::timestamptz),
  ('60000000-0000-4000-8000-000000000141'::uuid, 'assistant', 'uuid-tie',
    null::jsonb, '[{"type":"text","text":"uuid-tie"}]'::jsonb,
    '2026-08-22 00:11:00+00'::timestamptz),
  ('60000000-0000-4000-8000-000000000151'::uuid, 'user', 'same-user',
    null::jsonb, null::jsonb, '2026-08-22 00:12:00+00'::timestamptz),
  ('60000000-0000-4000-8000-000000000152'::uuid, 'user', 'same-user',
    null::jsonb, null::jsonb, '2026-08-22 00:13:00+00'::timestamptz),
  ('60000000-0000-4000-8000-000000000161'::uuid, 'assistant', 'nonadjacent',
    null::jsonb, null::jsonb, '2026-08-22 00:14:00+00'::timestamptz),
  ('60000000-0000-4000-8000-000000000162'::uuid, 'user', 'middle',
    null::jsonb, null::jsonb, '2026-08-22 00:15:00+00'::timestamptz),
  ('60000000-0000-4000-8000-000000000163'::uuid, 'assistant', 'nonadjacent',
    null::jsonb, null::jsonb, '2026-08-22 00:16:00+00'::timestamptz),
  ('60000000-0000-4000-8000-000000000171'::uuid, 'assistant', 'exact',
    null::jsonb, null::jsonb, '2026-08-22 00:17:00+00'::timestamptz),
  ('60000000-0000-4000-8000-000000000172'::uuid, 'assistant', 'exact ',
    null::jsonb, null::jsonb, '2026-08-22 00:18:00+00'::timestamptz)
) as message(id, role, content, tool_activities, content_blocks, created_at);

insert into public.chat_messages(id, session_id, role, content, created_at)
select '60000000-0000-4000-8000-000000000201', session_b_id,
  'assistant', 'terminal', '2026-08-22 00:01:30+00'
from phase6a_fixture;

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '60000000-0000-4000-8000-000000000001',
  true
);
select throws_ok(
  $$insert into public.chat_messages(
      id, session_id, role, content, superseded_by
    )
    values (
      '60000000-0000-4000-8000-000000000301',
      '60000000-0000-4000-8000-000000000004',
      'assistant', 'client marker injection',
      '60000000-0000-4000-8000-000000000102'
    )$$,
  '42501',
  'new row violates row-level security policy for table "chat_messages"',
  'authenticated clients cannot inject a server-managed marker on insert'
);
reset role;

select lives_ok(
  'select private.backfill_chat_message_supersessions()',
  'legacy duplicate backfill completes'
);

select is(
  (select count(*) from public.chat_messages
    where session_id = '60000000-0000-4000-8000-000000000004'
      and superseded_by is null),
  14::bigint,
  'canonical message reads exclude superseded audit rows'
);

select is(
  (select superseded_by from public.chat_messages
    where id = '60000000-0000-4000-8000-000000000101'),
  '60000000-0000-4000-8000-000000000102'::uuid,
  'terminal lifecycle state is the first richness dimension'
);
select is(
  (select superseded_by from public.chat_messages
    where id = '60000000-0000-4000-8000-000000000111'),
  '60000000-0000-4000-8000-000000000112'::uuid,
  'artifact count breaks equal-terminal ties'
);
select is(
  (select superseded_by from public.chat_messages
    where id = '60000000-0000-4000-8000-000000000121'),
  '60000000-0000-4000-8000-000000000122'::uuid,
  'block count breaks equal-terminal and equal-artifact ties'
);
select is(
  (select superseded_by from public.chat_messages
    where id = '60000000-0000-4000-8000-000000000142'),
  '60000000-0000-4000-8000-000000000141'::uuid,
  'lexicographically lower UUID wins an otherwise equal duplicate group'
);
select is(
  (select count(*) from public.chat_messages where superseded_by is not null),
  4::bigint,
  'backfill marks exactly the duplicate losers'
);
select is(
  (select count(*) from public.chat_messages
    where id in (
      '60000000-0000-4000-8000-000000000101',
      '60000000-0000-4000-8000-000000000111',
      '60000000-0000-4000-8000-000000000121',
      '60000000-0000-4000-8000-000000000142'
    )),
  4::bigint,
  'superseded losers remain stored for audit and recovery'
);
select is(
  (select count(*) from public.chat_messages
    where id in (
      '60000000-0000-4000-8000-000000000151',
      '60000000-0000-4000-8000-000000000152'
    ) and superseded_by is null),
  2::bigint,
  'adjacent user messages are never merged'
);
select is(
  (select count(*) from public.chat_messages
    where id in (
      '60000000-0000-4000-8000-000000000161',
      '60000000-0000-4000-8000-000000000163'
    ) and superseded_by is null),
  2::bigint,
  'nonadjacent assistant messages are never merged'
);
select is(
  (select superseded_by from public.chat_messages
    where id = '60000000-0000-4000-8000-000000000201'),
  null::uuid,
  'identical content in another session is never merged'
);
select is(
  (select count(*) from public.chat_messages
    where id in (
      '60000000-0000-4000-8000-000000000171',
      '60000000-0000-4000-8000-000000000172'
    ) and superseded_by is null),
  2::bigint,
  'content equivalence remains exact and does not trim whitespace'
);

create temporary table phase6a_first_markers as
select id, superseded_by
from public.chat_messages
order by id;

select lives_ok(
  'select private.backfill_chat_message_supersessions()',
  'legacy duplicate backfill can be repeated safely'
);
select results_eq(
  'select id, superseded_by from public.chat_messages order by id',
  'select id, superseded_by from phase6a_first_markers order by id',
  'a repeated backfill is idempotent'
);

insert into public.chat_messages(
  id, session_id, role, content, content_blocks, created_at
)
values (
  '60000000-0000-4000-8000-000000000104',
  '60000000-0000-4000-8000-000000000004',
  'assistant',
  'terminal',
  '[{"type":"tool","status":"completed"},{"type":"tool","status":"failed"}]',
  '2026-08-22 00:02:30+00'
);

select is(
  private.backfill_chat_message_supersessions(),
  2,
  'a newly arrived richer duplicate updates both existing canonical links'
);
select is(
  (select superseded_by from public.chat_messages
    where id = '60000000-0000-4000-8000-000000000101'),
  '60000000-0000-4000-8000-000000000104'::uuid,
  'an existing audit loser points directly to the newly selected winner'
);
select is(
  (select superseded_by from public.chat_messages
    where id = '60000000-0000-4000-8000-000000000102'),
  '60000000-0000-4000-8000-000000000104'::uuid,
  'the former winner becomes a direct loser of the richer new row'
);
select is(
  (
    select count(*)
    from public.chat_messages loser
    join public.chat_messages winner on winner.id = loser.superseded_by
    where winner.superseded_by is not null
  ),
  0::bigint,
  'backfill never leaves transitive supersession chains'
);

select throws_ok(
  $$update public.chat_messages
    set superseded_by = id
    where id = '60000000-0000-4000-8000-000000000102'$$,
  '23514',
  'new row for relation "chat_messages" violates check constraint "chat_messages_superseded_by_not_self_check"',
  'self-supersession is rejected by the database'
);
select throws_ok(
  $$delete from public.chat_messages
    where id = '60000000-0000-4000-8000-000000000104'$$,
  '23503',
  'update or delete on table "chat_messages" violates foreign key constraint "chat_messages_superseded_by_fkey" on table "chat_messages"',
  'canonical content cannot be deleted while an audit loser references it'
);

select * from finish();
rollback;
