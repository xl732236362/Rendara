# Phase 6A message canonicalization runbook

## Scope and invariants

Migration `20260823000001_phase6a_pagination.sql` marks legacy adjacent
assistant duplicates with `chat_messages.superseded_by`. It never deletes or
rewrites message content. A non-null marker points to the canonical row, while
the loser remains available for audit and recovery. The self-reference check
rejects invalid markers, and `ON DELETE RESTRICT` prevents deletion of a winner
while an audit row references it.

Canonical readers deployed after this migration must add
`superseded_by IS NULL`. During the rollout, older readers remain compatible:
they still receive all stored rows and apply the existing application-side
adjacent-message deduplication.

## Read-only preflight

Run as a database operator against the target database. These queries expose
only message/session identifiers, timestamps, and SHA-256 hashes. Do not select
or log `content`, `content_blocks`, or `tool_activities`.

Count the maximum affected rows. For each contiguous duplicate group, the
number of adjacent pairs equals the number of losers:

```sql
with ordered as (
  select
    id,
    session_id,
    role,
    content,
    lag(id) over message_order as previous_id,
    lag(role) over message_order as previous_role,
    lag(content) over message_order as previous_content
  from public.chat_messages
  window message_order as (
    partition by session_id
    order by created_at, id
  )
)
select count(*) as candidate_loser_count
from ordered
where role = 'assistant'
  and previous_role = 'assistant'
  and content is not distinct from previous_content;
```

Inspect the candidate pairs without disclosing message bodies:

```sql
with ordered as (
  select
    id,
    session_id,
    role,
    content,
    created_at,
    lag(id) over message_order as previous_id,
    lag(role) over message_order as previous_role,
    lag(content) over message_order as previous_content
  from public.chat_messages
  window message_order as (
    partition by session_id
    order by created_at, id
  )
)
select
  session_id,
  previous_id,
  id as current_id,
  encode(
    extensions.digest(convert_to(content, 'UTF8'), 'sha256'),
    'hex'
  ) as content_sha256,
  created_at
from ordered
where role = 'assistant'
  and previous_role = 'assistant'
  and content is not distinct from previous_content
order by session_id, created_at, id;
```

Unexpected volume, session concentration, or hashes spanning a known user
boundary is a stop condition. Investigate by identifier through the approved
privacy-safe support path; do not add message bodies to deployment logs.

## Deployment order and permissions

1. Apply the database migration before deploying canonical readers.
2. Confirm the migration log marker and affected count.
3. Run the database verification queries below.
4. Deploy server reads that filter `superseded_by IS NULL`.
5. Monitor pagination and message-count metrics before completing rollout.

`authenticated` has no `UPDATE` privilege on `chat_messages` or
`superseded_by`, cannot execute the maintenance function, and the insert RLS
policy requires a null marker. Among application roles, only `service_role` can execute
`private.backfill_chat_message_supersessions()`. Keep that function inside the
controlled database maintenance boundary; it is not a public application RPC.

The migration also adds deterministic pagination indexes. `brand_kits` is
currently user-scoped and has no `workspace_id`, so its index and subsequent
query key are `(user_id, created_at ASC, id ASC)`. Do not invent a workspace
scope without a separate ownership migration.

## Cursor signing-key rotation

Pagination cursors are signed, scoped to their resource query, and carry a
key identifier plus an expiry. Treat the signing key as a versioned secret;
never rotate by replacing the active value in place.

1. Publish the new key as the signer and keep the previous key as
   verify-only. New cursors use the new key ID; readers accept both IDs during
   the overlap.
2. Keep cursor TTL at seven days. The old verify key must remain available for
   the full seven-day TTL **plus the rollback window**. The default rollback
   window is seven additional days, so retain the old key for at least 14 days
   after the rotation (and longer while rollback remains possible).
3. Monitor invalid-signature, expired-cursor, and cursor-scope-conflict rates
   throughout the overlap. A rollback restores the previous signer while
   retaining both verification keys; do not invalidate live cursors merely to
   force a rotation.
4. After the TTL and rollback window have elapsed with no rollback or queued
   requests using the old key, remove the old key from the verifier set, then
   remove it from secret storage. Record the key IDs, overlap start/end,
   observed metrics, and operator correlation ID.

Removal order is therefore: deploy dual-key verification, switch the signer,
wait seven-day TTL plus rollback window, remove old verification, and remove
the old secret last. Never delete the old secret before application instances
and queued requests can no longer validate cursors signed with it.

## Verification and affected count

The backfill emits this structured database log marker:

```text
marker=phase6a_chat_message_supersession_backfill affected_count=<integer>
```

Capture the marker, count, migration version, environment, deployment ID, and
operator correlation ID. The log intentionally contains no message content.

After deployment, verify stored audit rows and direct canonical references:

```sql
select count(*) as stored_superseded_count
from public.chat_messages
where superseded_by is not null;

select count(*) as invalid_reference_count
from public.chat_messages loser
left join public.chat_messages winner on winner.id = loser.superseded_by
where loser.superseded_by is not null
  and (
    winner.id is null
    or winner.superseded_by is not null
    or winner.session_id <> loser.session_id
  );
```

`invalid_reference_count` must be zero. A second controlled execution is safe
and should return zero when no new legacy rows were added:

```sql
select private.backfill_chat_message_supersessions() as affected_count;
```

## Forward-fix an erroneous marker

Never delete either row and never edit message content. Stage the reviewed
loser/winner pairs in a transaction, inspect only hashes and identifiers, then
clear the incorrect marker with an expected-winner guard:

```sql
begin;

create temporary table marker_forward_fix (
  loser_id uuid primary key,
  expected_winner_id uuid not null
) on commit drop;

-- Replace only with pairs approved in the incident/change record.
insert into marker_forward_fix(loser_id, expected_winner_id)
values
  ('00000000-0000-0000-0000-000000000000',
   '00000000-0000-0000-0000-000000000001');

select
  loser.id as loser_id,
  winner.id as winner_id,
  loser.session_id,
  encode(
    extensions.digest(convert_to(loser.content, 'UTF8'), 'sha256'),
    'hex'
  ) as loser_content_sha256,
  encode(
    extensions.digest(convert_to(winner.content, 'UTF8'), 'sha256'),
    'hex'
  ) as winner_content_sha256
from marker_forward_fix fix
join public.chat_messages loser on loser.id = fix.loser_id
join public.chat_messages winner on winner.id = fix.expected_winner_id
where loser.superseded_by = fix.expected_winner_id
for update of loser;

update public.chat_messages loser
set superseded_by = null
from marker_forward_fix fix
where loser.id = fix.loser_id
  and loser.superseded_by = fix.expected_winner_id
returning loser.id;

commit;
```

The number of returned IDs must equal the approved fix set. Record that count
under a distinct incident marker such as
`phase6a_message_marker_forward_fix`; never include content in logs. If counts
or hashes differ, roll back and investigate rather than broadening the update.

## Rollback posture

Roll back canonical reader code first if application behavior regresses. Keep
the additive column, constraints, markers, and audit rows in place. Correct bad
markers with the forward-fix procedure above. Dropping constraints or deleting
messages destroys safety or evidence and is not an approved rollback path.
