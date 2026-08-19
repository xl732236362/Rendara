begin;

create extension if not exists pgtap with schema extensions;
select plan(15);

select has_table('public', 'agent_effects', 'Agent effects are durable');
select ok(not has_table_privilege('authenticated', 'public.agent_effects', 'select'),
  'Agent effects are server-only');
select ok(has_function_privilege('service_role',
  'public.claim_agent_attempt(uuid,text,integer,timestamptz)', 'execute'),
  'service role can claim attempts');
select ok(has_function_privilege('service_role',
  'public.commit_agent_canvas_revision(uuid,uuid,bigint,jsonb,uuid,uuid,bigint,text,text,jsonb,uuid,text)',
  'execute'), 'service role can atomically commit Agent canvas effects');

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '30000000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
  'phase3-agent@example.test', '', now(),
  '{"provider":"email","providers":["email"]}', '{}', now(), now()
);

create temporary table phase3_fixture(workspace_id uuid, project_id uuid, canvas_id uuid);
insert into phase3_fixture
select id, '30000000-0000-4000-8000-000000000003',
  '30000000-0000-4000-8000-000000000004'
from public.workspaces
where owner_user_id = '30000000-0000-4000-8000-000000000001';

insert into public.projects(id, workspace_id, name, slug, created_by)
select project_id, workspace_id, 'Phase 3', 'phase-3-agent',
  '30000000-0000-4000-8000-000000000001' from phase3_fixture;
insert into public.canvases(id, project_id, name, created_by)
select canvas_id, project_id, 'Phase 3 canvas',
  '30000000-0000-4000-8000-000000000001' from phase3_fixture;
insert into public.chat_sessions(
  id, canvas_id, title, created_by, thread_id
) select '30000000-0000-4000-8000-000000000005', canvas_id,
  'Phase 3 session', '30000000-0000-4000-8000-000000000001',
  'phase-3-thread' from phase3_fixture;

select public.accept_agent_run(
  '30000000-0000-4000-8000-000000000006',
  '30000000-0000-4000-8000-000000000007',
  '30000000-0000-4000-8000-000000000001', 'request-1', 'digest-1',
  '30000000-0000-4000-8000-000000000005', 'phase-3-thread', null,
  workspace_id, project_id, canvas_id,
  '["image.generate"]', 'policy-1', 'catalog-1',
  '["json-image-prompt"]'
) from phase3_fixture;

select is((select fencing_token::integer from public.claim_agent_attempt(
  '30000000-0000-4000-8000-000000000007', 'worker-1', 1000,
  now())), 1, 'first claim receives fencing token 1');
select throws_ok(
  $$select public.claim_agent_attempt('30000000-0000-4000-8000-000000000007','worker-2',1000,now() + interval '500 milliseconds')$$,
  'P0001', 'attempt_lease_unavailable', 'active lease excludes another owner');
select is((select fencing_token::integer from public.claim_agent_attempt(
  '30000000-0000-4000-8000-000000000007', 'worker-2', 1000,
  now() + interval '2 seconds')), 2, 'expired takeover increments fencing token');

select throws_ok(
  $$select public.begin_agent_effect('30000000-0000-4000-8000-000000000006','30000000-0000-4000-8000-000000000007',1,'tool-1','input-1')$$,
  'P0001', 'run_not_active', 'stale fencing token cannot reserve an effect');
select is((select status from public.begin_agent_effect(
  '30000000-0000-4000-8000-000000000006',
  '30000000-0000-4000-8000-000000000007', 2, 'tool-1', 'input-1')),
  'reserved', 'active attempt reserves an effect');
select public.complete_agent_effect(
  '30000000-0000-4000-8000-000000000006',
  '30000000-0000-4000-8000-000000000007', 2, 'tool-1', 'input-1',
  '{"jobId":"job-1"}');
select is((select status from public.begin_agent_effect(
  '30000000-0000-4000-8000-000000000006',
  '30000000-0000-4000-8000-000000000007', 2, 'tool-1', 'input-1')),
  'completed', 'identical effect replay returns the result');
select throws_ok(
  $$select public.begin_agent_effect('30000000-0000-4000-8000-000000000006','30000000-0000-4000-8000-000000000007',2,'tool-1','input-other')$$,
  'P0001', 'agent_effect_conflict', 'changed effect input conflicts');

update public.agent_run_attempts
set lease_expires_at = now() - interval '1 second'
where attempt_id = '30000000-0000-4000-8000-000000000007';
select throws_ok(
  $$select public.begin_agent_effect('30000000-0000-4000-8000-000000000006','30000000-0000-4000-8000-000000000007',2,'tool-2','input-2')$$,
  'P0001', 'run_not_active', 'an expired attempt fences subsequent effects');
select throws_ok(
  $$select public.resume_agent_attempt('30000000-0000-4000-8000-000000000006','30000000-0000-4000-8000-000000000008','catalog-other','["image.generate"]','policy-2','[]')$$,
  'P0001', 'skill_catalog_changed', 'resume rejects a changed catalog');
select is((select capabilities::text from public.resume_agent_attempt(
  '30000000-0000-4000-8000-000000000006',
  '30000000-0000-4000-8000-000000000008', 'catalog-1',
  '["image.generate","video.generate"]', 'policy-2', '[]')),
  '["image.generate"]', 'resume cannot expand capabilities');
select throws_ok(
  $$select public.commit_agent_canvas_revision(
    '30000000-0000-4000-8000-000000000004',
    '30000000-0000-4000-8000-000000000001', 0, '{}'::jsonb,
    '30000000-0000-4000-8000-000000000006',
    '30000000-0000-4000-8000-000000000007', 2,
    'tool-stale-canvas', 'input-stale', '{}'::jsonb,
    null, null
  )$$,
  'P0001', 'run_not_active',
  'stale attempt cannot commit a Canvas mutation or effect');

select * from finish();
rollback;
