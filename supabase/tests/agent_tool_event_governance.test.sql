begin;

create extension if not exists pgtap with schema extensions;
select plan(17);

select has_column('public', 'agent_runs', 'current_attempt_id',
  'runs identify their one current attempt');
select has_function('public', 'finalize_agent_run',
  array['uuid','uuid','bigint','text','jsonb'],
  'one canonical finalization RPC exists');
select ok(has_function_privilege('service_role',
  'public.finalize_agent_run(uuid,uuid,bigint,text,jsonb)', 'execute'),
  'only the server operation path can finalize runs');
select ok(not has_function_privilege('authenticated',
  'public.finalize_agent_run(uuid,uuid,bigint,text,jsonb)', 'execute'),
  'clients cannot finalize runs directly');
select has_function('public', 'commit_canvas_revision',
  array['uuid','uuid','bigint','jsonb','uuid','text'],
  'canvas commits expose only the canonical server-owned event contract');
select ok(to_regprocedure(
  'public.commit_canvas_revision(uuid,uuid,bigint,jsonb,uuid,text,text,jsonb)'
  ) is null, 'the caller-controlled canvas event contract is removed');

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '31000000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
  'governance@example.test', '', now(),
  '{"provider":"email","providers":["email"]}', '{}', now(), now()
);

create temporary table governance_fixture(
  workspace_id uuid, project_id uuid, canvas_id uuid
);
insert into governance_fixture
select id, '31000000-0000-4000-8000-000000000003',
  '31000000-0000-4000-8000-000000000004'
from public.workspaces
where owner_user_id = '31000000-0000-4000-8000-000000000001';

insert into public.projects(id, workspace_id, name, slug, created_by)
select project_id, workspace_id, 'Governance', 'agent-governance',
  '31000000-0000-4000-8000-000000000001' from governance_fixture;
insert into public.canvases(id, project_id, name, created_by)
select canvas_id, project_id, 'Governance canvas',
  '31000000-0000-4000-8000-000000000001' from governance_fixture;
insert into public.chat_sessions(id, canvas_id, title, created_by, thread_id)
select '31000000-0000-4000-8000-000000000005', canvas_id,
  'Governance session', '31000000-0000-4000-8000-000000000001',
  'governance-thread' from governance_fixture;
insert into public.background_jobs(
  id, workspace_id, project_id, canvas_id, session_id, thread_id,
  queue_name, job_type, status, payload, created_by, idempotency_key,
  request_fingerprint, credits_cost
)
select '31000000-0000-4000-8000-000000000009', workspace_id, project_id,
  canvas_id, '31000000-0000-4000-8000-000000000005', 'governance-thread',
  'image_generation_jobs', 'image_generation', 'succeeded', '{}'::jsonb,
  '31000000-0000-4000-8000-000000000001', 'governance-job',
  'governance-fingerprint', 0 from governance_fixture;

select is((select public.commit_canvas_revision(
  canvas_id, '31000000-0000-4000-8000-000000000001', 0,
  '{"elements":[],"appState":{},"files":{}}'::jsonb,
  '31000000-0000-4000-8000-000000000009', 'attach-result'
) ->> 'replayed' from governance_fixture), 'false',
  'a committed canvas mutation is applied once');
select is((select public.commit_canvas_revision(
  canvas_id, '31000000-0000-4000-8000-000000000001', 0,
  '{"elements":[],"appState":{},"files":{}}'::jsonb,
  '31000000-0000-4000-8000-000000000009', 'attach-result'
) ->> 'replayed' from governance_fixture), 'true',
  'an identical effect replay does not mutate the canvas again');
select is((select count(*)::integer from public.domain_outbox o
  join governance_fixture f on f.canvas_id = o.aggregate_id
  where o.event_type = 'canvas.updated'), 1,
  'one canvas revision creates exactly one authoritative outbox event');
select throws_ok(format(
  $$insert into public.domain_outbox(
    aggregate_type,aggregate_id,aggregate_version,event_type,payload
  ) values ('canvas',%L::uuid,1,'canvas.updated','{}'::jsonb)$$,
  (select canvas_id from governance_fixture)), '23505', null,
  'a second event for the same canvas revision is rejected');

select public.accept_agent_run(
  '31000000-0000-4000-8000-000000000006',
  '31000000-0000-4000-8000-000000000007',
  '31000000-0000-4000-8000-000000000001', 'request-1', 'digest-1',
  '31000000-0000-4000-8000-000000000005', 'governance-thread', null,
  workspace_id, project_id, canvas_id, '["image.generate"]', 'policy-1',
  'catalog-1', '["json-image-prompt"]'
) from governance_fixture;

select lives_ok(
  $$set constraints all immediate$$,
  'acceptance satisfies deferred run and attempt terminal alignment triggers');
set constraints all deferred;

select is((select current_attempt_id from public.agent_runs
  where id = '31000000-0000-4000-8000-000000000006'),
  '31000000-0000-4000-8000-000000000007'::uuid,
  'acceptance records the current attempt');
select is((select fencing_token::integer from public.claim_agent_attempt(
  '31000000-0000-4000-8000-000000000007', 'worker-1', 10000, now())),
  1, 'the current attempt can be claimed');

select is((select status from public.finalize_agent_run(
  '31000000-0000-4000-8000-000000000006',
  '31000000-0000-4000-8000-000000000007', 1, 'completed', '{}'::jsonb)),
  'completed', 'the current attempt finalizes the run');
select ok((select r.status = a.status and r.completed_at = a.completed_at
  from public.agent_runs r
  join public.agent_run_attempts a on a.attempt_id = r.current_attempt_id
  where r.id = '31000000-0000-4000-8000-000000000006'),
  'run and current attempt finalize together');
select is((select status from public.finalize_agent_run(
  '31000000-0000-4000-8000-000000000006',
  '31000000-0000-4000-8000-000000000007', 1, 'canceled', '{}'::jsonb)),
  'completed', 'the first terminal transition wins');
select throws_ok(
  $$select public.finalize_agent_run(
    '31000000-0000-4000-8000-000000000006',
    '31000000-0000-4000-8000-000000000008', 1, 'failed', '{}'::jsonb)$$,
  'P0001', 'agent_attempt_not_current',
  'a non-current attempt cannot finalize the run');

select * from finish();
rollback;
