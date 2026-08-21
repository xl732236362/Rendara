begin;
select plan(18);

select has_table('public', 'realtime_canvas_events', 'durable realtime event table exists');
select has_table('public', 'realtime_canvas_cursors', 'canvas cursor counters are durable');
select ok(not has_table_privilege('authenticated', 'public.realtime_canvas_events', 'select'),
  'realtime events are server-only');
select ok(has_function_privilege('service_role',
  'public.append_realtime_canvas_event(uuid,uuid,text,jsonb,timestamptz)', 'execute'),
  'service role can append realtime events');
select ok(has_function_privilege('service_role',
  'public.read_realtime_canvas_events(uuid,bigint,integer)', 'execute'),
  'service role can replay realtime events');
select ok(has_function_privilege('service_role',
  'public.get_realtime_canvas_replay_status(uuid,bigint)', 'execute'),
  'service role can inspect replay gaps');

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '50000000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
  'phase5-realtime@example.test', '', now(),
  '{"provider":"email","providers":["email"]}', '{}', now(), now()
);

create temporary table phase5_fixture(workspace_id uuid, project_id uuid, canvas_id uuid);
insert into phase5_fixture
select id, '50000000-0000-4000-8000-000000000002',
  '50000000-0000-4000-8000-000000000003'
from public.workspaces
where owner_user_id = '50000000-0000-4000-8000-000000000001';

insert into public.projects(id, workspace_id, name, slug, created_by)
select project_id, workspace_id, 'Phase 5', 'phase-5-realtime',
  '50000000-0000-4000-8000-000000000001' from phase5_fixture;
insert into public.canvases(id, project_id, name, created_by)
select canvas_id, project_id, 'Phase 5 canvas',
  '50000000-0000-4000-8000-000000000001' from phase5_fixture;

select is((select canvas_seq from public.append_realtime_canvas_event(
  '50000000-0000-4000-8000-000000000010',
  (select canvas_id from phase5_fixture), 'canvas.sync',
  '{"revision":1}'::jsonb, now())), 1::bigint,
  'first event receives cursor 1');
select is((select inserted from public.append_realtime_canvas_event(
  '50000000-0000-4000-8000-000000000010',
  (select canvas_id from phase5_fixture), 'canvas.sync',
  '{"revision":1}'::jsonb, now())), false,
  'identical event retry is idempotent');
select throws_ok($$select public.append_realtime_canvas_event(
  '50000000-0000-4000-8000-000000000010',
  (select canvas_id from phase5_fixture), 'canvas.sync', '{"revision":2}'::jsonb, now())$$,
  'P0001', 'realtime_event_conflict', 'event id cannot be reused with changed payload');
select is((select count(*) from public.read_realtime_canvas_events(
  (select canvas_id from phase5_fixture), 0, 10)), 1::bigint,
  'replay returns persisted event');
select is((select count(*) from public.read_realtime_canvas_events(
  (select canvas_id from phase5_fixture), 1, 10)), 0::bigint,
  'replay cursor excludes already delivered event');
select is((select gap from public.get_realtime_canvas_replay_status(
  (select canvas_id from phase5_fixture), 0)), false,
  'fresh replay cursor has no gap');
select throws_ok($$select public.append_realtime_canvas_event(
  '50000000-0000-4000-8000-000000000011',
  (select canvas_id from phase5_fixture), ' ', '{}'::jsonb, now())$$,
  'P0001', 'realtime_event_invalid', 'blank event type is rejected');

select is((select canvas_seq from public.append_realtime_canvas_event(
  '50000000-0000-4000-8000-000000000012',
  (select canvas_id from phase5_fixture), 'canvas.sync',
  '{"revision":2}'::jsonb, now())), 2::bigint,
  'second event receives cursor 2');
select is((select canvas_seq from public.append_realtime_canvas_event(
  '50000000-0000-4000-8000-000000000013',
  (select canvas_id from phase5_fixture), 'canvas.sync',
  '{"revision":3}'::jsonb, now())), 3::bigint,
  'third event receives cursor 3');
update public.realtime_canvas_events set created_at = now() - interval '2 days';
select is(public.prune_realtime_canvas_events(now() - interval '1 day', 1), 2,
  'retention removes only old events outside the latest window');
select is((select canvas_seq from public.append_realtime_canvas_event(
  '50000000-0000-4000-8000-000000000014',
  (select canvas_id from phase5_fixture), 'canvas.sync',
  '{"revision":4}'::jsonb, now())), 4::bigint,
  'cursor remains monotonic after retention cleanup');
select is((select gap from public.get_realtime_canvas_replay_status(
  (select canvas_id from phase5_fixture), 1)), true,
  'replay reports a gap after old events were pruned');

select * from finish();
rollback;
