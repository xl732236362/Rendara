# Loomic Phase 2 Transaction Consistency, Job State Machine, and Canvas Revision Design

## Status

- Date: 2026-08-18
- Baseline: `56215dfab34f1a77afc6d56e9942192652a3f36c`
- Scope: ENG-001, ENG-002, ENG-011, and ENG-017
- Decision: approved recommended design

## Product Decisions

1. A generation submission is charged once when the submission transaction commits. Cancellation, timeout, retry exhaustion, permanent failure, or dead-lettering does not automatically refund that charge.
2. Refunds remain available only as explicit human-initiated compensation. Every compensation is idempotent, auditable, and replay-safe.
3. Cancellation of a running job is cooperative. A request first records `cancel_requested`; the worker confirms `canceled` only when no Loomic business effect has committed. A committed success wins the race.
4. Canvas writes use strict optimistic concurrency control. Browser conflicts return HTTP 409. Agent and worker domain operations may re-read and retry a bounded number of times.
5. PGMQ is treated as an at-least-once delivery mechanism at the business layer. Loomic does not claim distributed atomicity or exactly-once provider invocation.

## Scope and Non-Goals

Phase 2 owns transactional generation submission, charging, queue insertion, job transitions, leases, retries, cancellation races, terminal settlement, human compensation, Canvas revision control, unified Canvas writes, and post-commit event publication.

The following are explicitly out of scope:

- Phase 3 removal of Agent arbitrary execution and dynamic Skills, plus explicit canvas-scoped tool governance.
- Phase 4's complete versioned node protocol and registry.
- Phase 5's shared realtime bus, CRDT, and cross-node replay infrastructure.
- Guaranteeing that an external model provider is invoked exactly once when the provider has no idempotency API.
- Making Supabase Storage uploads atomic with PostgreSQL transactions.

## Chosen Architecture

PGMQ and Loomic business tables live in the same PostgreSQL database. A security-hardened submission RPC therefore performs the idempotency reservation, job insert, credit deduction, immutable debit ledger insert, job-credit association, and `pgmq.send` in one database transaction. Any error rolls back all of these effects.

External provider work is never performed while holding a database transaction or row lock. Workers atomically claim a job lease, call the provider outside the transaction, and atomically commit a result only if their lease remains current and cancellation has not won. A task-level effect receipt prevents duplicate Loomic result and Canvas effects.

Canvas writes use a second narrow RPC. It compares `expected_revision`, writes content and increments revision, records any effect key, and inserts a domain outbox row in one transaction. Events are published only after commit. External consumers use an inbox or equivalent unique event receipt.

## Generation Submission

### Idempotency Contract

Queue-backed generation requests require a client-provided `idempotencyKey`. The unique scope is:

`workspace_id + created_by + job_type + idempotency_key`

The server derives a canonical request fingerprint from all fields that affect execution or billing. Reusing a key with the same fingerprint returns the existing job and debit result. Reusing it with a different fingerprint returns `409 idempotency_conflict`. Raw keys and payloads are not written to logs; logs contain a bounded digest.

### Atomic Submission RPC

The RPC performs the following work in a fixed order:

1. Authenticate the caller and verify workspace membership and referenced resource ownership.
2. Insert or lock the idempotency record and compare the request fingerprint.
3. Lock the workspace credit balance.
4. Validate balance and atomically debit it.
5. Insert the `background_jobs` row in `queued` state.
6. Insert the immutable `generation_deduct` ledger row with a unique debit business key.
7. Associate the debit transaction and cost with the job.
8. Call `pgmq.send` for the job's known queue.
9. Store the PGMQ message id and mark the submission idempotency record committed.
10. Return the job and debit identifiers.

The queue name is derived by trusted database logic from `job_type`; it is not arbitrary caller input. The RPC has a fixed `search_path`, validates positive bounded charge amounts, and is executable only by the intended server role or an explicitly audited authenticated entry point.

## Job State Machine

### States

- `queued`: committed, charged, and present in PGMQ; no worker owns an active lease.
- `running`: a worker owns the current active lease and may execute.
- `cancel_requested`: cancellation was requested while a worker may still be executing.
- `succeeded`: the single Loomic success effect committed.
- `failed`: the current attempt failed and remains eligible for retry.
- `canceled`: cancellation was confirmed before a success effect committed.
- `dead_letter`: execution is permanently exhausted or non-retryable.

### Legal Transitions

| From | To | Authority | Required predicate |
| --- | --- | --- | --- |
| queued | running | worker claim | no active lease; attempt budget remains |
| failed | running | worker claim | no active lease; attempt budget remains |
| queued | canceled | user cancellation | no success effect and no active execution |
| running | cancel_requested | user cancellation | current state is running |
| failed | canceled | user cancellation | no success effect and no active execution |
| cancel_requested | canceled | current worker/reaper | no success effect committed |
| running | succeeded | current worker | lease token matches; no cancellation won; unique effect inserted |
| cancel_requested | succeeded | current worker | success effect had already committed in the same transaction |
| running | failed | current worker | lease token matches; retryable error |
| cancel_requested | failed | current worker | lease token matches; failure is recorded before cancellation confirmation |
| running | dead_letter | current worker | lease token matches; permanent error or attempts exhausted |
| cancel_requested | dead_letter | current worker/reaper | permanent failure is known; no automatic refund |

Terminal states do not transition. Repeated commands that describe the already-committed same outcome return the existing outcome; contradictory commands return `invalid_job_transition`.

### Lease and Retry Protocol

A claim RPC atomically checks the state and lease expiry, increments the attempt count, writes `lease_token`, `lease_owner`, `lease_expires_at`, and transitions to `running`. A partial index supports reclaiming active jobs by lease expiry. Lease renewal and every worker settlement require the current token.

If a process dies or PGMQ visibility expires, another delivery may reclaim an expired lease. The previous worker's late renewal or settlement affects zero rows and is reported as `stale_job_lease`. The worker then discards its result and must not attach it to a Canvas.

PGMQ visibility is renewed outside the business transaction. Failure to renew does not transfer business ownership by itself; only the database claim RPC establishes ownership. A retryable attempt records `failed`, keeps the PGMQ message available, and is reclaimed through the same claim path. A terminal settlement archives or deletes the message after the database commit. A crash between settlement and message removal is safe because duplicate delivery observes the terminal job and produces no second effect.

### Cancellation Race

Queued or retry-waiting jobs can be confirmed `canceled` immediately. Running jobs move to `cancel_requested`. Workers check cancellation before provider invocation, after provider response, and immediately before result commit. Provider-specific cancellation is best effort.

The result commit transaction serializes against cancellation. If the success effect commits first, the job is `succeeded`; later cancellation is rejected as terminal. If cancellation confirmation commits first, a worker settlement is rejected. Receipt of a cancellation request is never represented as proof that the external provider stopped.

### Exactly-Once Business Effect

Each durable side effect uses a stable business key, for example `job_id + effect_kind`. A unique constraint on effect receipts ensures one Loomic success result and one generated-asset attachment per job/effect kind. Providers that support idempotency receive a stable provider key derived from this identity. Providers without such support may be invoked more than once after a crash, but Loomic commits at most one result and one Canvas attachment.

## Credit Ledger and Human Compensation

Generation debits are immutable and uniquely keyed by the submission/job business identity. A duplicate submission returns the original debit. Job failure and cancellation never call compensation logic.

Human compensation uses a separate RPC and requires:

- a globally unique `compensation_key` supplied by the operational workflow;
- the original debit transaction and job identity;
- operator identity and a non-empty reason;
- a positive amount bounded by policy;
- a unique compensation ledger row.

Replaying the same key and identical request returns the existing compensation. Reusing the key with different parameters returns `409 compensation_conflict`. The balance update and ledger append occur in one transaction. Compensation never mutates or deletes the original debit.

## Canvas Revision and Unified Writes

### Revision Contract

`canvases.revision` is a non-negative, monotonically increasing bigint. Canvas reads and HTTP responses include it. Every write carries `expectedRevision` and returns the committed revision.

The Canvas commit RPC validates access and executes compare-and-swap semantics equivalent to:

```sql
update public.canvases
set content = p_content,
    revision = revision + 1
where id = p_canvas_id
  and revision = p_expected_revision
returning revision;
```

The actual RPC also records an optional effect receipt and an outbox event in the same transaction. A mismatch returns `canvas_revision_conflict` with expected and current revision. Missing or unauthorized resources retain the existing non-disclosure semantics.

### Writer Behavior

- Browser full-document saves remain supported in Phase 2 but must use CAS. On conflict, autosave pauses, local unsaved content is retained, and the user is prompted to reload. There is no silent overwrite or automatic whole-document merge.
- Agent `applyOperations` reads the current revision, applies deterministic operations, and commits by CAS. A revision conflict causes at most three re-read/reapply attempts with bounded jitter.
- Generated asset attachment follows the same read/apply/CAS path and carries a stable effect key. Duplicate delivery returns the existing effect.
- Retries are permitted only for replay-safe domain operations. Stale full-document content is never retried as if it were an operation.

All server-side Canvas writes flow through the application/repository boundary. Direct `.update({ content })` calls outside that boundary are prohibited by an architecture test.

### Storage Boundary

Binary upload remains outside the short Canvas database transaction. Content references only a successfully uploaded stable object. If upload succeeds but all CAS attempts fail, the object may be orphaned; the failure is logged with object path and correlation ids, and the runbook describes detection and later reclamation. Phase 2 does not claim atomicity between Storage and PostgreSQL.

## Transactional Outbox and Inbox

Every successful Canvas commit inserts an outbox row in the same transaction. Job terminal transitions that need publication use the same pattern. An event contains:

- immutable `event_id`;
- aggregate type and id;
- aggregate revision or job transition version;
- event type and schema version;
- bounded non-sensitive payload;
- occurrence, availability, publication, attempt, and last-error metadata.

A dispatcher claims unpublished rows in small batches using `FOR UPDATE SKIP LOCKED`, publishes after the originating transaction has committed, and records success. Publication failure leaves the event retryable with bounded backoff. A crash after publish but before acknowledgement may publish twice; consumers therefore persist `event_id` in an inbox or provide an equivalent unique receipt.

Phase 2 connects this boundary to the existing in-process Canvas notification adapter. It does not introduce Phase 5 shared realtime infrastructure.

## Database Design and Security

The additive migration introduces the minimum structures needed for the contracts above: submission idempotency, job lease/transition metadata, effect receipts, compensation identity, Canvas revision, and outbox/inbox receipts. Existing rows receive safe defaults. Historical migrations are not edited.

Indexes target actual access paths: unique idempotency and effect keys, active jobs and expired leases, unpublished outbox rows, Canvas id/revision comparison, and ledger lookup. Partial indexes exclude terminal or published history where appropriate. Foreign keys and check constraints enforce positive attempts, valid lease shape, non-negative revision, and internally consistent timestamps.

All security-definer functions set a fixed `search_path`, fully qualify objects, revoke default public execution, and grant only required roles. Functions revalidate user, workspace, resource, and queue ownership. Service-role-only transition functions are not executable by authenticated clients. RLS and RPC permission tests prove these boundaries.

Transactions remain short and never include HTTP/provider/Storage calls. Functions acquire locks in a consistent order: idempotency identity, job when applicable, then workspace balance. Transition functions update one job row and related receipts in one transaction.

## Error and Logging Contract

Stable application errors include `idempotency_conflict`, `insufficient_credits`, `invalid_job_transition`, `stale_job_lease`, `job_already_terminal`, `canvas_revision_conflict`, and `compensation_conflict`.

Structured logs include correlation id, job/canvas/workspace id, event id, transition, attempt, lease owner, bounded lease/idempotency digest, expected/current revision, duration, and stable error code. They do not include access tokens, raw idempotency keys, provider secrets, full prompts, full Canvas content, or binary data.

## Testing Strategy

### Unit and Contract Tests

- Exhaustive legal and illegal state-transition table.
- Request fingerprint stability and conflict behavior.
- Queue message, lease, cancellation, and terminal duplicate handling.
- Canvas operation retry policy and non-retryable full-document conflicts.
- Structured log redaction and stable error mapping.

### Real PostgreSQL Integration Tests

Tests use independent database sessions and synchronization barriers rather than mocks. They cover:

- identical and conflicting concurrent submissions;
- concurrent debits against the same balance;
- rollback between debit and PGMQ send;
- repeated delivery and simultaneous lease claims;
- expired lease takeover and stale worker settlement;
- cancellation versus success commit;
- terminal settlement versus message removal crash window;
- duplicate and conflicting human compensation;
- two Canvas writers with one expected revision;
- browser versus Agent/worker writes;
- duplicate generated-asset effects;
- Canvas commit rollback producing no outbox event;
- outbox publish/acknowledgement failure and inbox deduplication.

### Fault Injection

Named failpoints exercise failure after debit before enqueue, after provider response before settlement, after settlement before PGMQ deletion, after Canvas upload before CAS, after Canvas update before transaction commit, and after event publish before dispatcher acknowledgement.

## Migration and Operations

Deployment is expand-and-contract without destructive cleanup in Phase 2:

1. Apply additive tables, columns, indexes, constraints, and RPCs.
2. Backfill revision and transition metadata and validate constraints.
3. Deploy compatible application readers and new transactional writers.
4. Enable architecture tests and permissions that reject legacy write paths.
5. Observe lease, duplicate, conflict, outbox age, and transition error metrics.

Rollback may return application code to a schema-compatible release and revoke new entry points, but it does not delete ledger, effect, idempotency, or outbox history. Data or invariant defects use a documented forward fix. The runbook includes queries for stuck queued/running jobs, expired leases, repeated PGMQ reads, unpublished outbox rows, Canvas conflicts, and compensation audit; it also documents safe replay and manual compensation.

## Acceptance Criteria

Phase 2 is complete only when:

- task creation, debit, ledger, and PGMQ enqueue are proven atomic from an empty database;
- duplicate requests cannot duplicate jobs or charges;
- every job transition is conditional and lease-aware;
- cancellation races cannot overwrite committed terminal outcomes;
- no automatic failure or cancellation refund path remains;
- human compensation is auditable and replay-safe;
- duplicate delivery cannot duplicate Loomic results or Canvas attachments;
- every Canvas write is revision-checked and server writes use the unified boundary;
- events are inserted transactionally and published with at-least-once/inbox semantics;
- real concurrency, fault-injection, RLS/RPC, zero-rebuild, full quality, Docker production entrypoint, and diff checks pass;
- the Phase 2 verification record, issue register, and operational runbook contain exact evidence;
- an independent review finds no unresolved critical correctness or scope issue;
- no Phase 3, 4, or 5 subsystem is pulled into the implementation.
