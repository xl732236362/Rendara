begin;

create extension if not exists pgtap with schema extensions;

select plan(37);

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

select ok(
  has_table_privilege('service_role', 'public.profiles', 'select'),
  'service role can read the profile returned by bootstrap_viewer'
);

select ok(
  has_table_privilege('service_role', 'public.workspaces', 'select'),
  'service role can read the workspace returned by bootstrap_viewer'
);

select ok(
  has_table_privilege('service_role', 'public.workspace_members', 'select'),
  'service role can read the membership returned by bootstrap_viewer'
);

select ok(
  has_table_privilege('authenticated', 'public.workspaces', 'select'),
  'authenticated users can resolve RLS-scoped workspaces'
);

select ok(
  has_table_privilege('authenticated', 'public.profiles', 'select'),
  'authenticated users can read their RLS-scoped profile'
);

select ok(
  has_table_privilege('authenticated', 'public.profiles', 'update'),
  'authenticated users can update their RLS-scoped profile'
);

select ok(
  has_table_privilege('authenticated', 'public.projects', 'update'),
  'authenticated users can archive projects allowed by project RLS'
);

select ok(
  has_table_privilege('authenticated', 'public.chat_sessions', 'insert'),
  'authenticated users can create RLS-scoped chat sessions'
);

select ok(
  has_table_privilege('authenticated', 'public.chat_sessions', 'update'),
  'authenticated users can update RLS-scoped chat sessions'
);

select ok(
  has_table_privilege('authenticated', 'public.chat_sessions', 'delete'),
  'authenticated users can delete RLS-scoped chat sessions'
);

select ok(
  has_table_privilege('authenticated', 'public.chat_messages', 'select'),
  'authenticated users can read messages in RLS-scoped sessions'
);

select ok(
  has_table_privilege('authenticated', 'public.chat_messages', 'insert'),
  'authenticated users can create messages in RLS-scoped sessions'
);

select ok(
  has_table_privilege('authenticated', 'public.chat_messages', 'delete'),
  'authenticated users can delete messages in RLS-scoped sessions'
);

select ok(
  has_table_privilege('service_role', 'public.credit_balances', 'select'),
  'service role can read credit balances at the billing boundary'
);

select ok(
  has_table_privilege('service_role', 'public.subscriptions', 'select'),
  'service role can read workspace subscriptions at the billing boundary'
);

select ok(
  has_table_privilege('service_role', 'public.daily_credit_claims', 'select'),
  'service role can read daily credit claim state'
);

select ok(
  has_table_privilege('service_role', 'public.credit_transactions', 'select'),
  'service role can read the credit transaction ledger'
);

select ok(
  has_table_privilege(
    'authenticated', 'public.brand_kits', 'select,insert,update,delete'
  ),
  'authenticated users can manage brand kits allowed by brand kit RLS'
);

select ok(
  has_table_privilege(
    'authenticated', 'public.brand_kit_assets',
    'select,insert,update,delete'
  ),
  'authenticated users can manage brand assets allowed by brand asset RLS'
);

select ok(
  has_table_privilege('service_role', 'public.background_jobs', 'select'),
  'service role can read jobs at runtime and worker boundaries'
);

select ok(
  has_table_privilege(
    'service_role', 'public.asset_objects', 'select,insert'
  ),
  'service role can resolve and persist generated asset records'
);

select ok(
  has_table_privilege(
    'authenticated', 'public.asset_objects', 'select,insert,delete'
  ),
  'authenticated users can manage asset records allowed by asset RLS'
);

select ok(
  has_table_privilege('authenticated', 'public.background_jobs', 'select'),
  'authenticated users can read jobs allowed by job RLS'
);

select * from finish();

rollback;
