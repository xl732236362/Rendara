begin;

create extension if not exists pgtap with schema extensions;

select plan(48);

select has_column(
  'public',
  'canvases',
  'revision',
  'canvases expose an optimistic concurrency revision'
);

select has_column(
  'public',
  'background_jobs',
  'transition_version',
  'jobs expose a monotonic transition version'
);

select has_column(
  'public',
  'background_jobs',
  'lease_token',
  'jobs record the current worker lease token'
);

select has_column(
  'public',
  'background_jobs',
  'lease_owner',
  'jobs record the current worker lease owner'
);

select has_column(
  'public',
  'background_jobs',
  'lease_expires_at',
  'jobs record worker lease expiry'
);

select has_column(
  'public',
  'background_jobs',
  'pgmq_message_id',
  'jobs retain the atomically enqueued PGMQ message id'
);

select has_table(
  'public',
  'generation_submission_keys',
  'generation submission idempotency records exist'
);

select has_table(
  'public',
  'job_effect_receipts',
  'job business effect receipts exist'
);

select has_table(
  'public',
  'credit_compensations',
  'human compensation audit records exist'
);

select has_table(
  'public',
  'domain_outbox',
  'transactional domain outbox exists'
);

select has_table(
  'public',
  'domain_inbox',
  'idempotent domain inbox exists'
);

select ok(
  'cancel_requested' = any(enum_range(null::public.background_job_status)::text[]),
  'job state enum includes cancel_requested'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.increment_job_attempt(uuid)',
    'execute'
  ),
  'existing worker mutation remains unavailable to authenticated clients'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.increment_job_attempt(uuid)',
    'execute'
  ),
  'service role retains existing worker mutation access during migration'
);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.canvases'::regclass),
  'canvas RLS remains enabled'
);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.background_jobs'::regclass),
  'job RLS remains enabled'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.submit_generation_job(uuid,uuid,text,text,public.background_job_type,jsonb,integer,text,uuid,uuid,uuid,text)',
    'execute'
  ),
  'authenticated clients cannot bypass application-owned pricing'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.submit_generation_job(uuid,uuid,text,text,public.background_job_type,jsonb,integer,text,uuid,uuid,uuid,text)',
    'execute'
  ),
  'service role can execute atomic generation submission'
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
) values (
  '10000000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated',
  'authenticated',
  'phase2-owner@example.test',
  '',
  now(),
  '{"provider":"email","providers":["email"]}',
  '{}',
  now(),
  now()
);

create temporary table phase2_fixture (
  workspace_id uuid not null,
  project_id uuid not null,
  canvas_id uuid not null,
  first_job_id uuid,
  first_debit_id uuid,
  second_job_id uuid,
  second_lease_token uuid,
  third_job_id uuid,
  third_lease_token uuid
);

grant select on phase2_fixture to authenticated;

insert into phase2_fixture (workspace_id, project_id, canvas_id)
select
  w.id,
  '10000000-0000-4000-8000-000000000003',
  '10000000-0000-4000-8000-000000000004'
from public.workspaces w
where w.owner_user_id = '10000000-0000-4000-8000-000000000001';

insert into public.projects (id, workspace_id, name, slug, created_by)
select
  project_id,
  workspace_id,
  'Phase 2 project',
  'phase-2-project',
  '10000000-0000-4000-8000-000000000001'
from phase2_fixture;

insert into public.canvases (id, project_id, name, created_by)
select
  canvas_id,
  project_id,
  'Phase 2 canvas',
  '10000000-0000-4000-8000-000000000001'
from phase2_fixture;

update public.credit_balances cb
set balance = 100
from phase2_fixture f
where cb.workspace_id = f.workspace_id;

with submitted as (
  select public.submit_generation_job(
    f.workspace_id,
    '10000000-0000-4000-8000-000000000001',
    'phase2-submit-1',
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    'image_generation',
    '{"prompt":"atomic image","model":"image/model"}'::jsonb,
    7,
    'Phase 2 atomic image',
    f.project_id,
    f.canvas_id,
    null,
    'thread-phase2'
  ) as result
  from phase2_fixture f
)
update phase2_fixture
set first_job_id = (submitted.result -> 'job' ->> 'id')::uuid,
    first_debit_id = (submitted.result ->> 'debit_transaction_id')::uuid
from submitted;

select is(
  (select count(*)::integer from public.background_jobs where idempotency_key = 'phase2-submit-1'),
  1,
  'first atomic submission creates one job'
);

select is(
  (select count(*)::integer from public.credit_transactions ct join phase2_fixture f on f.first_job_id = ct.job_id where ct.transaction_type = 'generation_deduct'),
  1,
  'first atomic submission creates one debit ledger entry'
);

select is(
  (select cb.balance from public.credit_balances cb join phase2_fixture f using (workspace_id)),
  93,
  'first atomic submission debits the balance once'
);

select is(
  (
    select (public.submit_generation_job(
      f.workspace_id,
      '10000000-0000-4000-8000-000000000001',
      'phase2-submit-1',
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      'image_generation',
      '{"prompt":"atomic image","model":"image/model"}'::jsonb,
      7,
      'Phase 2 atomic image',
      f.project_id,
      f.canvas_id,
      null,
      'thread-phase2'
    ) ->> 'replayed')::boolean
    from phase2_fixture f
  ),
  true,
  'identical submission replay returns the committed outcome'
);

select is(
  (select count(*)::integer from public.background_jobs where idempotency_key = 'phase2-submit-1'),
  1,
  'identical submission replay does not duplicate the job'
);

select is(
  (select cb.balance from public.credit_balances cb join phase2_fixture f using (workspace_id)),
  93,
  'identical submission replay does not debit again'
);

select throws_ok(
  format(
    $sql$select public.submit_generation_job(%L::uuid,%L::uuid,%L,%L,'image_generation','{"prompt":"different"}'::jsonb,7,'conflict',%L::uuid,%L::uuid,null,null)$sql$,
    (select workspace_id from phase2_fixture),
    '10000000-0000-4000-8000-000000000001',
    'phase2-submit-1',
    'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    (select project_id from phase2_fixture),
    (select canvas_id from phase2_fixture)
  ),
  '23505',
  'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST',
  'same idempotency key with a different fingerprint conflicts'
);

select is(
  (select count(*)::integer from pgmq.q_image_generation_jobs),
  1,
  'atomic submission enqueues exactly one PGMQ message'
);

with submitted as (
  select public.submit_generation_job(
    f.workspace_id,
    '10000000-0000-4000-8000-000000000001',
    'phase2-submit-2',
    '1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    'image_generation',
    '{"prompt":"lease test"}'::jsonb,
    0,
    'Phase 2 lease test',
    f.project_id,
    f.canvas_id,
    null,
    null
  ) as result
  from phase2_fixture f
)
update phase2_fixture
set second_job_id = (submitted.result -> 'job' ->> 'id')::uuid
from submitted;

with claimed as (
  select public.claim_generation_job(second_job_id, 'worker-a', 60) as result
  from phase2_fixture
)
update phase2_fixture
set second_lease_token = (claimed.result ->> 'lease_token')::uuid
from claimed;

select is(
  (select j.status::text from public.background_jobs j join phase2_fixture f on f.second_job_id = j.id),
  'running',
  'worker claim atomically moves a job to running'
);

select is(
  (select j.attempt_count from public.background_jobs j join phase2_fixture f on f.second_job_id = j.id),
  1,
  'worker claim increments the attempt once'
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000001',
  true
);

select is(
  (
    select public.request_generation_cancellation(second_job_id) -> 'job' ->> 'status'
    from phase2_fixture
  ),
  'cancel_requested',
  'running cancellation records a cooperative cancel request'
);

reset role;

select is(
  (
    select public.begin_generation_effect(second_job_id, second_lease_token) ->> 'kind'
    from phase2_fixture
  ),
  'canceled',
  'cancellation before effect intent prevents the external effect from starting'
);

select is(
  (
    select public.claim_generation_job(second_job_id, 'worker-c', 60) ->> 'kind'
    from phase2_fixture
  ),
  'busy',
  'duplicate delivery cannot clear an active canceled worker lease'
);

select is(
  (
    select public.settle_generation_job(
      second_job_id,
      second_lease_token,
      'succeeded',
      '{"url":"ignored"}'::jsonb,
      null,
      null
    ) -> 'job' ->> 'status'
    from phase2_fixture
  ),
  'succeeded',
  'a committed generation result wins over a late cancellation request'
);

select throws_ok(
  format(
    $sql$select public.settle_generation_job(%L::uuid,%L::uuid,'succeeded','{"url":"late"}'::jsonb,null,null)$sql$,
    (select second_job_id from phase2_fixture),
    (select second_lease_token from phase2_fixture)
  ),
  'P0001',
  'STALE_JOB_LEASE',
  'late settlement from the canceled worker lease is rejected'
);

select is(
  (select count(*)::integer from public.job_effect_receipts r join phase2_fixture f on f.second_job_id = r.job_id),
  1,
  'successful settlement after cancellation records exactly one generation effect'
);

with submitted as (
  select public.submit_generation_job(
    f.workspace_id,
    '10000000-0000-4000-8000-000000000001',
    'phase2-submit-3',
    '2123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    'image_generation',
    '{"prompt":"stale lease"}'::jsonb,
    0,
    'Phase 2 stale lease',
    f.project_id,
    f.canvas_id,
    null,
    null
  ) as result
  from phase2_fixture f
)
update phase2_fixture
set third_job_id = (submitted.result -> 'job' ->> 'id')::uuid
from submitted;

with claimed as (
  select public.claim_generation_job(third_job_id, 'worker-b', 60) as result
  from phase2_fixture
)
update phase2_fixture
set third_lease_token = (claimed.result ->> 'lease_token')::uuid
from claimed;

update public.background_jobs j
set lease_expires_at = now() - interval '1 second'
from phase2_fixture f
where j.id = f.third_job_id;

select throws_ok(
  format(
    $sql$select public.settle_generation_job(%L::uuid,%L::uuid,'succeeded','{}'::jsonb,null,null)$sql$,
    (select third_job_id from phase2_fixture),
    (select third_lease_token from phase2_fixture)
  ),
  'P0001',
  'STALE_JOB_LEASE',
  'an expired lease cannot settle before another worker claims the job'
);

select throws_ok(
  format(
    $sql$select public.settle_generation_job(%L::uuid,%L::uuid,'succeeded','{}'::jsonb,null,null)$sql$,
    (select third_job_id from phase2_fixture),
    '10000000-0000-4000-8000-000000000099'
  ),
  'P0001',
  'STALE_JOB_LEASE',
  'a stale worker token cannot settle a running job'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
select public.request_generation_cancellation(third_job_id) from phase2_fixture;
reset role;
insert into public.generation_effect_attempts (job_id, lease_token, state)
select third_job_id, third_lease_token, 'ambiguous' from phase2_fixture;
select is(
  (
    select public.claim_generation_job(third_job_id, 'recovery-worker', 60) -> 'job' ->> 'status'
    from phase2_fixture
  ),
  'dead_letter',
  'expired cancellation with an ambiguous external effect cannot become canceled'
);

select is(
  (
    select public.compensate_generation_charge(
      f.workspace_id,
      'support-case-1',
      f.first_job_id,
      f.first_debit_id,
      '10000000-0000-4000-8000-000000000001',
      3,
      'Support-approved partial compensation'
    ) ->> 'replayed'
    from phase2_fixture f
  ),
  'false',
  'first human compensation creates a refund ledger entry'
);

select is(
  (
    select public.compensate_generation_charge(
      f.workspace_id,
      'support-case-1',
      f.first_job_id,
      f.first_debit_id,
      '10000000-0000-4000-8000-000000000001',
      3,
      'Support-approved partial compensation'
    ) ->> 'replayed'
    from phase2_fixture f
  ),
  'true',
  'identical human compensation replay returns the original entry'
);

select is(
  (select count(*)::integer from public.credit_transactions where metadata ->> 'compensation_key' = 'support-case-1'),
  1,
  'human compensation replay cannot duplicate a refund'
);

select throws_ok(
  format(
    $sql$select public.compensate_generation_charge(%L::uuid,'support-case-over',%L::uuid,%L::uuid,%L::uuid,8,'Over original debit')$sql$,
    (select workspace_id from phase2_fixture),
    (select first_job_id from phase2_fixture),
    (select first_debit_id from phase2_fixture),
    '10000000-0000-4000-8000-000000000001'
  ),
  '22023',
  'COMPENSATION_EXCEEDS_DEBIT',
  'human compensation cannot exceed the original debit'
);

select throws_ok(
  format(
    $sql$select public.compensate_generation_charge(%L::uuid,'support-case-duplicate',%L::uuid,%L::uuid,%L::uuid,5,'Duplicate compensation')$sql$,
    (select workspace_id from phase2_fixture),
    (select first_job_id from phase2_fixture),
    (select first_debit_id from phase2_fixture),
    '10000000-0000-4000-8000-000000000001'
  ),
  '22023',
  'COMPENSATION_EXCEEDS_DEBIT',
  'different keys cannot cumulatively compensate beyond the original debit'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
select is(
  (select public.request_generation_cancellation(first_job_id) -> 'job' ->> 'status' from phase2_fixture),
  'canceled',
  'queued cancellation reaches canceled without starting an effect'
);
reset role;

select is(
  (
    select o.payload ->> 'userId' from public.domain_outbox o
    join phase2_fixture f on f.first_job_id = o.aggregate_id
    where o.event_type = 'generation.job.canceled'
  ),
  '10000000-0000-4000-8000-000000000001',
  'generation cancellation events identify the owning user for publication'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.commit_canvas_revision(uuid,uuid,bigint,jsonb,uuid,text,text,jsonb)',
    'execute'
  ),
  'authenticated clients cannot supply trusted Job effect or outbox fields'
);

select is(
  (
    select public.save_canvas_revision(
      f.canvas_id,
      0,
      '{"elements":[],"appState":{},"files":{}}'::jsonb
    ) ->> 'revision'
    from phase2_fixture f
  ),
  '1',
  'Canvas compare-and-swap advances the revision once'
);

select throws_ok(
  format(
    $sql$select public.save_canvas_revision(%L::uuid,0,'{"elements":[],"appState":{},"files":{}}'::jsonb)$sql$,
    (select canvas_id from phase2_fixture)
  ),
  '40001',
  'CANVAS_REVISION_CONFLICT',
  'stale Canvas revision is rejected instead of overwriting content'
);

select is(
  (
    select count(*)::integer
    from public.domain_outbox o
    join phase2_fixture f on f.canvas_id = o.aggregate_id
    where o.event_type = 'canvas.updated'
  ),
  1,
  'successful Canvas commit emits exactly one transactional outbox event'
);

select * from finish();

rollback;
