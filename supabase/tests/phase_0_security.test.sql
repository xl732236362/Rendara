begin;

create extension if not exists pgtap with schema extensions;

select plan(14);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.canvases'::regclass),
  'canvases has row-level security enabled'
);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.chat_sessions'::regclass),
  'chat sessions have row-level security enabled'
);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.agent_runs'::regclass),
  'agent runs have row-level security enabled'
);

insert into auth.users (
  id,
  instance_id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000101',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'phase0-owner@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}',
    '{}',
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000202',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'phase0-other@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}',
    '{}',
    now(),
    now()
  );

insert into public.projects (id, workspace_id, name, slug, created_by)
select
  '00000000-0000-0000-0000-000000000301',
  id,
  'Owner project',
  'phase0-owner-project',
  owner_user_id
from public.workspaces
where owner_user_id = '00000000-0000-0000-0000-000000000101';

insert into public.projects (id, workspace_id, name, slug, created_by)
select
  '00000000-0000-0000-0000-000000000302',
  id,
  'Other project',
  'phase0-other-project',
  owner_user_id
from public.workspaces
where owner_user_id = '00000000-0000-0000-0000-000000000202';

insert into public.canvases (id, project_id, name, created_by)
values
  (
    '00000000-0000-0000-0000-000000000401',
    '00000000-0000-0000-0000-000000000301',
    'Owner canvas',
    '00000000-0000-0000-0000-000000000101'
  ),
  (
    '00000000-0000-0000-0000-000000000402',
    '00000000-0000-0000-0000-000000000302',
    'Other canvas',
    '00000000-0000-0000-0000-000000000202'
  );

insert into public.chat_sessions (id, canvas_id, title, created_by)
values
  (
    '00000000-0000-0000-0000-000000000501',
    '00000000-0000-0000-0000-000000000401',
    'Owner session',
    '00000000-0000-0000-0000-000000000101'
  ),
  (
    '00000000-0000-0000-0000-000000000502',
    '00000000-0000-0000-0000-000000000402',
    'Other session',
    '00000000-0000-0000-0000-000000000202'
  );

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000101',
  true
);

select is(
  (select count(*)::integer from public.canvases),
  1,
  'an authenticated user sees only canvases in their workspace'
);

select is(
  (
    select count(*)::integer
    from public.canvases
    where id = '00000000-0000-0000-0000-000000000402'
  ),
  0,
  'an authenticated user cannot enumerate another workspace canvas'
);

select is(
  (select count(*)::integer from public.chat_sessions),
  1,
  'an authenticated user sees only sessions in their workspace'
);

select is(
  (
    select count(*)::integer
    from public.chat_sessions
    where id = '00000000-0000-0000-0000-000000000502'
  ),
  0,
  'an authenticated user cannot enumerate another workspace session'
);

reset role;

select ok(
  not has_table_privilege('anon', 'public.agent_runs', 'select'),
  'anonymous clients cannot read server-owned agent runs'
);

select ok(
  not has_table_privilege('authenticated', 'public.agent_runs', 'select'),
  'authenticated clients cannot read server-owned agent runs directly'
);

select ok(
  not has_table_privilege('authenticated', 'public.agent_runs', 'insert'),
  'authenticated clients cannot create server-owned agent runs directly'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.claim_daily_credits(uuid,integer)',
    'execute'
  ),
  'authenticated clients cannot execute server-only credit grants'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.claim_daily_credits(uuid,integer)',
    'execute'
  ),
  'service role retains access to server-only credit grants'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.increment_job_attempt(uuid)',
    'execute'
  ),
  'authenticated clients cannot mutate worker attempt counters'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.increment_job_attempt(uuid)',
    'execute'
  ),
  'service role retains access to worker attempt counters'
);

select * from finish();

rollback;
