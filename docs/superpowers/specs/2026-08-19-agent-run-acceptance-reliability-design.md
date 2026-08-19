# Agent Run Acceptance Reliability Design

## Context

Agent requests currently reach the WebSocket server and resolve the selected
model, but can fail before the server acknowledges the run. The browser waits
10 seconds for `command.ack`; when the server is still resolving and persisting
the run, the browser reports the generic `Failed to get response.` message.

The acceptance path repeats authorization and scope lookups across the
WebSocket handler and `createAcceptAgentRun`. With observed Supabase request
latencies of roughly one to five seconds, these serial round trips can exceed
the browser deadline. The path also lacks stage-level timeouts and logs, so a
stalled lookup is indistinguishable from a stalled persistence RPC. Separately,
Fastify request logs currently include the WebSocket `token` query parameter.

The configured `openai:gpt-5.6-terra` model and the configured OpenAI-compatible
proxy were independently verified with both regular and streaming requests.
Model invocation is therefore outside the root cause of this failure.

## Goals

- Resolve and authorize the complete Agent run scope once per request.
- Preserve atomic creation of the run, attempt, and outbox records.
- Return a WebSocket acknowledgement within a predictable deadline.
- Bound every external operation and expose the failing stage in logs and
  client-visible errors.
- Keep WebSocket and HTTP Agent entry points behaviorally consistent.
- Prevent credentials and bearer tokens from appearing in application logs.
- Provide regression coverage for slow and unavailable dependencies.

## Non-goals

- Changing the Agent model or model provider.
- Moving Agent orchestration into a background worker.
- Caching authorization results across requests.
- Replacing Supabase or the `accept_agent_run` transaction.
- Refactoring unrelated chat, generation, or canvas behavior.

## Chosen Approach

Use a single authoritative run-context resolver at the application boundary.
It resolves the session, canvas, project, workspace, thread, and user scope in
one authorization flow. Both WebSocket and HTTP entry points pass that frozen
context to Agent acceptance. Acceptance no longer re-queries session or canvas
scope, and the existing `accept_agent_run` RPC remains the atomic write
boundary.

This approach is preferred over a larger database RPC because authorization
policy remains visible and testable in TypeScript. It is preferred over caching
or merely extending the browser timeout because it removes the redundant work
instead of hiding its latency.

## Architecture

### Authorized run context

Introduce an immutable `AuthorizedAgentRunContext` with these fields:

- `userId`
- `sessionId`
- `threadId`
- `conversationId`
- `canvasId`
- `projectId`
- `workspaceId`
- `accessToken`

The context resolver accepts the authenticated principal and run request. It
must obtain the session and its related canvas/project/workspace scope through
a single user-scoped query. It rejects missing resources and any mismatch
between the request's `canvasId` and the session's canvas. `conversationId`
remains an independent conversation/event correlation identifier; it is
validated by the public request schema but is not treated as a Canvas authority
identifier. The access token is carried only in memory and must never be
serialized or logged.

Workspace model resolution runs after context resolution and reads settings for
the canonical `context.workspaceId`. It must not use the viewer's default
workspace as a substitute. A workspace settings failure continues to fall back
to the configured server model, but it is logged with a stable stage and error
code. A client-selected model retains its current precedence and skips the
workspace settings lookup.

### Shared entry-point behavior

WebSocket and `POST /api/agent/runs` use the same context resolver and the same
acceptance use case. Entry points are responsible only for authentication,
request parsing, transport-specific responses, and forwarding the authorized
context.

`createAcceptAgentRun` receives the authorized context rather than resolver
callbacks. It derives capabilities and effective built-in Skills, freezes the
execution context, calculates the request digest, and invokes the repository
exactly once.

### Atomic acceptance

`accept_agent_run` remains responsible for atomically inserting or resolving:

- the canonical `agent_runs` row;
- the first `agent_run_attempts` row;
- the `agent.run.accepted` domain outbox event.

Idempotency remains keyed by user and client request identity. A repeated
request with the same digest returns the existing run; a digest mismatch
returns `agent_acceptance_conflict`.

`clientRequestId` identifies one user submission, not one transport attempt.
The browser generates it once when the user submits a message and retains the
normalized request until acceptance has a definitive outcome. Connection
retries and acceptance-timeout retries resend the same request with the same
`clientRequestId`. A deliberate retry after a terminal Agent/model failure is a
new submission and receives a new identifier. The retained request excludes
`accessToken`; each transport attempt obtains and attaches the current token so
replay does not reuse expired credentials.

The request digest covers the normalized request (excluding `accessToken`) and
the canonical user/session/Canvas scope. It is computed before entering the
acceptance deadline so the expected value remains available even when the RPC
does not return. Reconciliation compares this digest before an existing run can
be reused.

An acceptance transport timeout is an indeterminate result, not proof that the
database transaction rolled back. After such a timeout, the server performs a
bounded lookup by `(userId, clientRequestId)`:

- a matching digest returns the existing accepted run and its persisted model;
- a different digest returns `agent_acceptance_conflict`;
- no visible row returns `agent_acceptance_indeterminate` and instructs the
  client to retry only with the same `clientRequestId`.

The persisted model, rather than a newly resolved workspace default, is used
when an existing run is reconciled or rehydrated. The same identifier makes a
late commit safe: a subsequent acceptance call is serialized by the existing
advisory lock and returns the original run instead of creating a duplicate.

No acknowledgement is sent before the transaction succeeds or reconciliation
finds the matching durable run. The server then registers or rehydrates that
run in the in-memory runtime and marks it active for the Canvas before sending
the acknowledgement. Model streaming begins after the acknowledgement attempt.
If acknowledgement delivery is lost, reconnect can discover the active run; if
the process exits before or after acknowledgement, replaying the retained
request with the same `clientRequestId` rehydrates the durable run.

Runtime registration returns one of three explicit outcomes:

- `created`: this handler owns the new stream execution;
- `existing_active`: an in-memory execution already owns the stream, so this
  handler only acknowledges the existing `runId` and never calls `streamRun` or
  clears its active-run registration;
- `rehydrated`: no in-memory execution exists, so this handler rebuilds it from
  the replayed normalized request and becomes the sole stream owner.

Only the handler that owns execution may start, cancel, or clear that active
runtime entry. This prevents a reconnect or acceptance retry from consuming the
same async stream twice or clearing another handler's active state.

`agent.run.accepted` remains a lifecycle outbox event, not the execution
trigger. The domain-event publisher must explicitly support and acknowledge
this event so it cannot become a permanently retrying poison event. Runtime
recovery is driven by idempotent request replay because the outbox intentionally
does not contain prompts, credentials, or attachment content. A failure between
durable acceptance and runtime registration leaves the row in `accepted`; the
next same-identifier replay registers it and creates no additional run or
attempt.

## Timeouts and Failure Semantics

Apply explicit deadlines at dependency boundaries rather than one opaque
deadline around the entire handler:

- authorized context resolution: 4 seconds;
- workspace model/settings enrichment: 2 seconds, with server-model fallback;
- acceptance RPC: 4 seconds;
- acceptance reconciliation after an indeterminate result: 2 seconds;
- Agent persistence initialization: 10 seconds;
- first model response event: 30 seconds after acknowledgement.

The WebSocket client ACK deadline becomes 15 seconds. This is an outer safety
limit, not the primary latency mechanism. The worst bounded pre-ACK path is 12
seconds (context, settings, acceptance, then reconciliation), leaving 3 seconds
for runtime registration and transport delivery. Timeouts race the dependency
against an explicit rejecting timer, abort their underlying request when the
client supports cancellation, and retain rejection handlers for any late
settlement. A dependency that ignores cancellation must still stop blocking the
request boundary. Aborting a transport does not change acceptance into a known
rollback; reconciliation and stable-id replay remain mandatory.

Stable server error codes:

| Code | Meaning | Retryable |
| --- | --- | --- |
| `agent_context_timeout` | Scope lookup exceeded its deadline | Yes |
| `agent_context_unavailable` | Scope storage returned a transient dependency failure | Yes |
| `agent_context_forbidden` | Session or canvas is inaccessible or mismatched | No |
| `agent_acceptance_indeterminate` | Acceptance timed out and reconciliation found no visible result | Yes, same `clientRequestId` only |
| `agent_acceptance_conflict` | Idempotency key was reused with different input | No |
| `agent_acceptance_unavailable` | Acceptance returned a definitive transient database error | Yes, same `clientRequestId` only |
| `agent_acceptance_failed` | Acceptance returned a definitive non-transient database error | No |
| `agent_runtime_registration_failed` | Durable acceptance exists but runtime registration failed | Yes, same `clientRequestId` only |
| `agent_persistence_timeout` | LangGraph persistence initialization stalled | Yes |
| `agent_first_event_timeout` | Model produced no event before its deadline | Yes |

HTTP entry points map these codes to the existing structured application error
envelope. WebSocket failures use a terminal `run.failed` event after execution
has started. Pre-ACK failures use the existing `type: "error"` envelope extended
with `action: "agent.run"`, `clientRequestId`, `retryable`, and a safe
`requestId`. The client correlates this envelope to its pending Agent command
and rejects the ACK wait immediately. Shared schemas accept the stable Agent
codes in both boundary envelopes and terminal run events. The response never
includes raw upstream errors.

## Observability

Emit structured duration logs for these stages:

- `agent.context.resolve.started|completed|failed`
- `agent.model.resolve.completed|failed`
- `agent.accept.started|completed|failed`
- `agent.ack.completed|failed`
- `agent.persistence.init.completed|failed`
- `agent.model.first_event|failed`

Every record includes `requestId`, `clientRequestId`, `sessionId`, `canvasId`,
and `runId` when one exists. It includes `durationMs`, stable `errorCode`, and
`retryable` for failures. It must not include prompts, access tokens, API keys,
authorization headers, full attachment URLs, or raw upstream response bodies.

Configure Fastify request serialization to redact:

- `authorization` and `proxy-authorization` headers;
- `token`, `access_token`, `api_key`, and equivalent query parameters;
- configured provider keys if they occur in nested log objects.

WebSocket request logs should record the route pathname and safe metadata, not
the raw URL. Add a regression test using sentinel credentials and assert that
neither structured nor rendered logs contain them.

## Client Experience

Replace the catch-all English fallback with transport-independent localized
messages selected by stable error code. The UI distinguishes:

- connection unavailable;
- request acceptance timed out and can be retried;
- access denied;
- request conflict;
- Agent service or model temporarily unavailable.

Retryable failures expose the existing resend/retry action without duplicating
the user's message. Acceptance retries resend the retained normalized request
with its original `clientRequestId`; they do not append another user message.
Retries after a terminal Agent/model failure create a new logical submission
and a new identifier. Non-retryable failures do not offer blind retry. Unknown
errors retain a localized generic fallback and include a short request ID for
support correlation.

## Testing Strategy

### Unit tests

- The context resolver performs one scope query and rejects every identifier
  mismatch while allowing `conversationId` to differ from `canvasId`.
- `createAcceptAgentRun` performs no authorization queries and passes the
  canonical context to the repository.
- Each dependency deadline maps to the correct stable error code and aborts
  pending work.
- Acceptance reconciliation returns a matching late commit, rejects a digest
  conflict, and keeps an unresolved result bound to the original identifier.
- Log serialization removes credentials in headers, query strings, and nested
  objects.
- Client error mapping renders localized text and the correct retry state.

### Integration tests

- WebSocket and HTTP entry points produce equivalent acceptance inputs.
- A deliberately slow scope repository fails within the context deadline.
- A deliberately slow acceptance repository fails before the client ACK
  deadline, reconciles its outcome, and does not create a duplicate run.
- A successful acceptance sends one ACK, creates one attempt, and begins one
  stream even when the client retries the same request ID.
- A commit followed by runtime-registration failure is rehydrated by the next
  same-identifier request without creating another run or attempt.
- `agent.run.accepted` is acknowledged by the domain-event publisher and does
  not remain in the retry queue.
- Reconnection after acknowledgement can recover the active run.
- A correlated pre-ACK error rejects the matching client wait without waiting
  for the outer timeout.
- Full logs from a WebSocket handshake containing sentinel credentials contain
  no sentinel values.

### Database tests

- Preserve the current pgTAP coverage for idempotent acceptance, conflicts,
  attempt fencing, and outbox creation.
- Add a statement-timeout test or repository integration test proving database
  timeout errors are normalized without weakening transaction atomicity.

## Rollout and Verification

1. Land context resolver and acceptance changes behind existing entry points.
   The request/response HTTP contract remains unchanged. The WebSocket error
   envelope receives additive correlation fields and therefore requires shared
   schema, server, and web changes in the same release.
2. Deploy server and web changes together so new error codes have client
   mappings at launch.
3. Monitor acceptance stage latency, timeout count, ACK delivery failures, and
   first-event latency separately.
4. Alert on acceptance timeout rate above 1% over 15 minutes or ACK P95 above
   3 seconds.
5. Retain generic unknown-error handling for older clients during rollout.

## Acceptance Criteria

- Agent ACK latency is below 3 seconds at P95 in the normal local/staging
  environment.
- Scope resolution performs one user-scoped data query per run request.
- Each transport attempt invokes `accept_agent_run` at most once; repeated
  attempts with the same logical `clientRequestId` resolve to one durable run
  and one active execution.
- Every transport retry for one user submission reuses its original
  `clientRequestId` and cannot create a second run or attempt.
- A database stall is reconciled or produces
  `agent_acceptance_indeterminate` within the configured deadline instead of an
  indefinite spinner or generic English message.
- A durable accepted run can be rehydrated after runtime-registration or
  process failure by replaying the same request identifier.
- `agent.run.accepted` outbox events are acknowledged rather than repeatedly
  failing as unsupported aggregates.
- No complete JWT, bearer token, Supabase key, or provider API key appears in
  application logs.
- WebSocket and HTTP acceptance paths enforce the same scope and idempotency
  rules.
- Existing Agent authority, tool-boundary, persistence, and canvas-operation
  test suites continue to pass.
