begin;

create extension if not exists pgtap with schema extensions;
select plan(30);

select has_table('public', 'generated_asset_attachment_intents',
  'generated asset attachment intents are durable');
select has_table('public', 'generated_asset_recovery_audits',
  'authenticated recovery attempts are audited');
select ok(not has_table_privilege('authenticated',
  'public.generated_asset_attachment_intents', 'select'),
  'attachment intents are server-only');
select ok(has_function_privilege('service_role',
  'public.claim_generated_asset_attachment_intents(text,integer,integer,timestamp with time zone)',
  'execute'), 'service role can claim attachment intents');
select ok(has_function_privilege('service_role',
  'public.fulfill_generated_asset_attachment(uuid,bigint,jsonb,jsonb,uuid,bigint)',
  'execute'), 'service role can fulfill attachment intents');

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '32000000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
  'attachment-reliability@example.test', '', now(),
  '{"provider":"email","providers":["email"]}', '{}', now(), now()
);

create temporary table attachment_fixture(
  workspace_id uuid, project_id uuid, canvas_id uuid, session_id uuid,
  run_id uuid, attempt_id uuid, job_id uuid, asset_id uuid, intent_id uuid
);
insert into attachment_fixture
select id,
  '32000000-0000-4000-8000-000000000003',
  '32000000-0000-4000-8000-000000000004',
  '32000000-0000-4000-8000-000000000005',
  '32000000-0000-4000-8000-000000000006',
  '32000000-0000-4000-8000-000000000007',
  '32000000-0000-4000-8000-000000000008',
  '32000000-0000-4000-8000-000000000009',
  '32000000-0000-4000-8000-000000000010'
from public.workspaces
where owner_user_id = '32000000-0000-4000-8000-000000000001';

insert into public.projects(id, workspace_id, name, slug, created_by)
select project_id, workspace_id, 'Attachment reliability',
  'attachment-reliability', '32000000-0000-4000-8000-000000000001'
from attachment_fixture;
insert into public.canvases(id, project_id, name, created_by, content)
select canvas_id, project_id, 'Attachment canvas',
  '32000000-0000-4000-8000-000000000001',
  '{"elements":[{"id":"existing","type":"rectangle","x":0,"y":0,"width":100,"height":100}],"appState":{"viewBackgroundColor":"#fff"},"files":{}}'::jsonb
from attachment_fixture;
insert into public.chat_sessions(id, canvas_id, title, created_by, thread_id)
select session_id, canvas_id, 'Attachment session',
  '32000000-0000-4000-8000-000000000001', 'attachment-thread'
from attachment_fixture;

select public.accept_agent_run(
  run_id, attempt_id, '32000000-0000-4000-8000-000000000001',
  'attachment-request', 'attachment-digest', session_id,
  'attachment-thread', null, workspace_id, project_id, canvas_id,
  '["image.generate","canvas.mutate"]', 'policy-1', 'catalog-1', '[]'
) from attachment_fixture;
select is((select claimed.fencing_token::integer
  from attachment_fixture fixture
  cross join lateral public.claim_agent_attempt(
    fixture.attempt_id, 'runtime-1', 60000, now()) claimed), 1,
  'Agent attempt is fenced before intent creation');
select is((select effect.status
  from attachment_fixture fixture
  cross join lateral public.begin_agent_effect(
    fixture.run_id, fixture.attempt_id, 1, 'tool-image-1', 'input-digest-1') effect),
  'reserved', 'Agent effect is reserved');

insert into public.background_jobs(
  id, workspace_id, project_id, canvas_id, session_id, thread_id,
  queue_name, job_type, status, payload, result, created_by,
  idempotency_key, request_fingerprint, credits_cost
)
select job_id, workspace_id, project_id, canvas_id, session_id,
  'attachment-thread', 'image_generation_jobs', 'image_generation',
  'succeeded', '{}'::jsonb,
  jsonb_build_object('asset_id', asset_id, 'mime_type', 'image/png',
    'width', 1024, 'height', 1024),
  '32000000-0000-4000-8000-000000000001', 'attachment-job',
  'attachment-fingerprint', 0
from attachment_fixture;
insert into public.asset_objects(
  id, workspace_id, project_id, bucket, object_path, mime_type,
  created_by, generation_job_id
)
select asset_id, workspace_id, project_id, 'project-assets',
  'generated/attachment.png', 'image/png',
  '32000000-0000-4000-8000-000000000001', job_id
from attachment_fixture;
insert into public.generated_asset_attachment_intents(
  id, job_id, effect_kind, state, workspace_id, project_id, canvas_id,
  session_id, user_id, media_type, placement_policy, run_id, attempt_id,
  fencing_token, logical_tool_call_id, input_digest
)
select intent_id, job_id, 'generated_asset_attached', 'pending', workspace_id,
  project_id, canvas_id, session_id,
  '32000000-0000-4000-8000-000000000001', 'image',
  '{"kind":"auto_right"}'::jsonb, run_id, attempt_id, 1,
  'tool-image-1', 'input-digest-1'
from attachment_fixture;

select is((select count(*)::integer from
  public.claim_generated_asset_attachment_intents('attachment-worker', 10, 30, now())),
  1, 'one due intent is claimed');
select is((select state from public.generated_asset_attachment_intents
  where id = (select intent_id from attachment_fixture)), 'running',
  'claim transitions the intent to running');

select is((select public.fulfill_generated_asset_attachment(
  intent.id, intent.claim_fencing_token,
  jsonb_build_object(
    'id', fixture.job_id::text, 'type', 'image',
    'fileId', fixture.job_id::text || '-file',
    'x', 0, 'y', 0, 'width', 512, 'height', 512,
    'customData', jsonb_build_object(
      'assetId', fixture.asset_id, 'generatedBy', 'agent')
  ),
  jsonb_build_object(
    'id', fixture.job_id::text || '-file', 'assetId', fixture.asset_id,
    'mimeType', 'image/png', 'created', 1
  ), fixture.attempt_id, 1
) ->> 'attachmentStatus'
from public.generated_asset_attachment_intents intent
join attachment_fixture fixture on fixture.intent_id = intent.id), 'attached',
  'fulfillment reports attached only after the transaction commits');
select is((select revision::integer from public.canvases
  where id = (select canvas_id from attachment_fixture)), 1,
  'attachment increments the canvas revision once');
select is((select jsonb_array_length(content->'elements') from public.canvases
  where id = (select canvas_id from attachment_fixture)), 2,
  'attachment preserves existing elements and appends one generated element');
select is((select count(*)::integer from public.job_effect_receipts
  where job_id = (select job_id from attachment_fixture)
    and effect_kind = 'generated_asset_attached'), 1,
  'attachment writes one durable receipt');
select is((select count(*)::integer from public.domain_outbox
  where aggregate_id = (select canvas_id from attachment_fixture)
    and event_type = 'canvas.updated' and aggregate_version = 1), 1,
  'attachment writes one authoritative canvas event');
select is((select status from public.agent_effects
  where run_id = (select run_id from attachment_fixture)
    and logical_tool_call_id = 'tool-image-1'), 'completed',
  'active Agent effect completes in the same transaction');

update public.canvases
set content = jsonb_set(content, '{elements}',
  (content->'elements') - 1), revision = revision + 1
where id = (select canvas_id from attachment_fixture);
select is((select public.fulfill_generated_asset_attachment(
  intent.id, intent.claim_fencing_token,
  jsonb_build_object('id', fixture.job_id::text, 'type', 'image',
    'fileId', fixture.job_id::text || '-file', 'x', 0, 'y', 0,
    'width', 512, 'height', 512),
  jsonb_build_object('id', fixture.job_id::text || '-file',
    'assetId', fixture.asset_id, 'mimeType', 'image/png', 'created', 1),
  fixture.attempt_id, 1
) ->> 'replayed'
from public.generated_asset_attachment_intents intent
join attachment_fixture fixture on fixture.intent_id = intent.id), 'true',
  'receipt replay succeeds after the user deletes the generated element');
select is((select jsonb_array_length(content->'elements') from public.canvases
  where id = (select canvas_id from attachment_fixture)), 1,
  'receipt replay never recreates a deleted element');
select is((select revision::integer from public.canvases
  where id = (select canvas_id from attachment_fixture)), 2,
  'receipt replay never increments revision');

insert into public.background_jobs(
  id, workspace_id, project_id, canvas_id, session_id, thread_id,
  queue_name, job_type, status, payload, created_by,
  idempotency_key, request_fingerprint, credits_cost
)
select '32000000-0000-4000-8000-000000000011', workspace_id, project_id,
  canvas_id, session_id, 'attachment-thread', 'image_generation_jobs',
  'image_generation', 'succeeded', '{}'::jsonb,
  '32000000-0000-4000-8000-000000000001', 'exhausted-attachment-job',
  'exhausted-attachment-fingerprint', 0
from attachment_fixture;
insert into public.generated_asset_attachment_intents(
  id, job_id, effect_kind, state, workspace_id, project_id, canvas_id,
  session_id, user_id, media_type, placement_policy, claim_owner,
  claim_expires_at, claim_fencing_token, attempt_count
)
select '32000000-0000-4000-8000-000000000012',
  '32000000-0000-4000-8000-000000000011', 'generated_asset_attached',
  'running', workspace_id, project_id, canvas_id, session_id,
  '32000000-0000-4000-8000-000000000001', 'image',
  '{"kind":"auto_right"}'::jsonb, 'expired-worker', now() - interval '1 second',
  8, 8
from attachment_fixture;

select is((select count(*)::integer from
  public.claim_generated_asset_attachment_intents('replacement-worker', 10, 30, now())),
  0, 'an expired eighth claim is not claimed a ninth time');
select is((select state from public.generated_asset_attachment_intents
  where id = '32000000-0000-4000-8000-000000000012'), 'failed',
  'an expired eighth claim terminates the intent');

insert into public.background_jobs(
  id, workspace_id, project_id, canvas_id, session_id, thread_id,
  queue_name, job_type, status, payload, result, created_by,
  idempotency_key, request_fingerprint, credits_cost
)
select '32000000-0000-4000-8000-000000000013', workspace_id, project_id,
  canvas_id, session_id, 'attachment-thread', 'image_generation_jobs',
  'image_generation', 'succeeded', '{}'::jsonb,
  jsonb_build_object('asset_id', '32000000-0000-4000-8000-000000000014'),
  '32000000-0000-4000-8000-000000000001', 'explicit-attachment-job',
  'explicit-attachment-fingerprint', 0
from attachment_fixture;
insert into public.asset_objects(
  id, workspace_id, project_id, bucket, object_path, mime_type,
  created_by, generation_job_id
)
select '32000000-0000-4000-8000-000000000014', workspace_id, project_id,
  'project-assets', 'generated/explicit-attachment.png', 'image/png',
  '32000000-0000-4000-8000-000000000001',
  '32000000-0000-4000-8000-000000000013'
from attachment_fixture;
insert into public.generated_asset_attachment_intents(
  id, job_id, effect_kind, workspace_id, project_id, canvas_id,
  session_id, user_id, media_type, placement_policy
)
select '32000000-0000-4000-8000-000000000015',
  '32000000-0000-4000-8000-000000000013', 'generated_asset_attached',
  workspace_id, project_id, canvas_id, session_id,
  '32000000-0000-4000-8000-000000000001', 'image',
  '{"kind":"explicit","x":10,"y":20,"width":300,"height":200}'::jsonb
from attachment_fixture;

select is((select count(*)::integer from
  public.claim_generated_asset_attachment_intents('explicit-worker', 10, 30, now())),
  1, 'an explicit-placement intent is claimed');
select throws_ok(
  $$select public.fulfill_generated_asset_attachment(
    '32000000-0000-4000-8000-000000000015', 1,
    '{"id":"32000000-0000-4000-8000-000000000013","type":"image","fileId":"32000000-0000-4000-8000-000000000013-file","x":11,"y":20,"width":300,"height":200}'::jsonb,
    '{"id":"32000000-0000-4000-8000-000000000013-file","assetId":"32000000-0000-4000-8000-000000000014","mimeType":"image/png","created":1}'::jsonb,
    null, null)$$,
  '22023', 'INVALID_EXPLICIT_PLACEMENT',
  'explicit placement must match the immutable intent'
);

select is(public.settle_generated_asset_attachment_intent(
  '32000000-0000-4000-8000-000000000015', 1, 'failed',
  'invalid_generated_asset', null) ->> 'state', 'failed',
  'a deterministic fulfillment error fails the claimed intent');
select is(public.retry_generated_asset_attachment(
  '32000000-0000-4000-8000-000000000001',
  (select canvas_id from attachment_fixture),
  '32000000-0000-4000-8000-000000000013') ->> 'attachmentStatus',
  'pending', 'authenticated recovery requeues the failed intent');
select is((select state from public.generated_asset_recovery_audits
  where intent_id = '32000000-0000-4000-8000-000000000015'), 'pending',
  'authenticated recovery creates a pending audit');
select is((select count(*)::integer from
  public.claim_generated_asset_attachment_intents('retry-worker', 10, 30, now())),
  1, 'the requeued recovery intent can be claimed');
select is(public.settle_generated_asset_attachment_intent(
  '32000000-0000-4000-8000-000000000015', 2, 'failed',
  'invalid_generated_asset', null) ->> 'state', 'failed',
  'a retried recovery can settle as terminally failed');
select is((select state from public.generated_asset_recovery_audits
  where intent_id = '32000000-0000-4000-8000-000000000015'), 'failed',
  'terminal recovery failure also completes its audit');

insert into public.background_jobs(
  id, workspace_id, project_id, canvas_id, session_id, thread_id,
  queue_name, job_type, status, payload, created_by,
  idempotency_key, request_fingerprint, credits_cost
)
select '32000000-0000-4000-8000-000000000016', workspace_id, project_id,
  canvas_id, session_id, 'attachment-thread', 'image_generation_jobs',
  'image_generation', 'queued', '{}'::jsonb,
  '32000000-0000-4000-8000-000000000001', 'attachment-queued-job',
  'attachment-queued-fingerprint', 0
from attachment_fixture;
insert into public.generated_asset_attachment_intents(
  id, job_id, effect_kind, workspace_id, project_id, canvas_id,
  session_id, user_id, media_type, placement_policy
)
select '32000000-0000-4000-8000-000000000017',
  '32000000-0000-4000-8000-000000000016',
  'generated_asset_attached', workspace_id, project_id, canvas_id, session_id,
  '32000000-0000-4000-8000-000000000001', 'image',
  '{"kind":"auto_right"}'::jsonb
from attachment_fixture;
select is((select count(*)::integer from
  public.claim_generated_asset_attachment_intents(
    'nonterminal-worker', 10, 30, now())), 0,
  'a nonterminal generation job does not consume attachment attempts');
select is((select state from public.generated_asset_attachment_intents
  where id = '32000000-0000-4000-8000-000000000017'), 'pending',
  'a nonterminal generation intent remains pending');

select * from finish();
rollback;
