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
- `canvasId`
- `projectId`
- `workspaceId`
- `accessToken`

The context resolver accepts the authenticated principal and run request. It
must obtain the session and its related canvas/project/workspace scope through
a single user-scoped query. It rejects missing resources and any mismatch
between the request's `canvasId`, `conversationId`, and the session's canvas.
The access token is carried only in memory and must never be serialized or
logged.

Workspace model resolution may run in parallel with context resolution. A
workspace settings failure continues to fall back to the configured server
model, but it is logged with a stable stage and error code.

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

No acknowledgement is sent before this transaction succeeds. This guarantees
that every acknowledged run has durable canonical authority and an execution
attempt. Model streaming begins only after acknowledgement delivery has been
attempted and the active run has been registered.

## Timeouts and Failure Semantics

Apply explicit deadlines at dependency boundaries rather than one opaque
deadline around the entire handler:

- authorized context resolution: 5 seconds;
- workspace model/settings enrichment: 5 seconds;
- acceptance RPC: 5 seconds;
- Agent persistence initialization: 10 seconds;
- first model event: 30 seconds.

The WebSocket client ACK deadline becomes 15 seconds. This is an outer safety
limit, not the primary latency mechanism; the two pre-ACK server stages must
normally complete well within it. Timeouts abort their underlying request when
the client supports cancellation and must not leave an unobserved promise.

Stable server error codes:

| Code | Meaning | Retryable |
| --- | --- | --- |
| `agent_context_timeout` | Scope lookup exceeded its deadline | Yes |
| `agent_context_forbidden` | Session or canvas is inaccessible or mismatched | No |
| `agent_acceptance_timeout` | Atomic acceptance did not finish in time | Yes |
| `agent_acceptance_conflict` | Idempotency key was reused with different input | No |
| `agent_acceptance_failed` | Acceptance returned an unexpected database error | Conditional |
| `agent_persistence_timeout` | LangGraph persistence initialization stalled | Yes |
| `agent_first_event_timeout` | Model produced no event before its deadline | Yes |

HTTP entry points map these codes to the existing structured application error
envelope. WebSocket failures use a terminal `run.failed` event when a durable
run exists and a `command.error` response when acceptance did not create a run.
The response includes the stable code, a safe user-facing message, and
`retryable`; it never includes raw upstream errors.

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
the user's message. Non-retryable failures do not offer blind retry. Unknown
errors retain a localized generic fallback and include a short request ID for
support correlation.

## Testing Strategy

### Unit tests

- The context resolver performs one scope query and rejects every identifier
  mismatch.
- `createAcceptAgentRun` performs no authorization queries and passes the
  canonical context to the repository.
- Each dependency deadline maps to the correct stable error code and aborts
  pending work.
- Log serialization removes credentials in headers, query strings, and nested
  objects.
- Client error mapping renders localized text and the correct retry state.

### Integration tests

- WebSocket and HTTP entry points produce equivalent acceptance inputs.
- A deliberately slow scope repository fails within the context deadline.
- A deliberately slow acceptance repository fails before the client ACK
  deadline and does not begin model streaming.
- A successful acceptance sends one ACK, creates one attempt, and begins one
  stream even when the client retries the same request ID.
- Reconnection after acknowledgement can recover the active run.
- Full logs from a WebSocket handshake containing sentinel credentials contain
  no sentinel values.

### Database tests

- Preserve the current pgTAP coverage for idempotent acceptance, conflicts,
  attempt fencing, and outbox creation.
- Add a statement-timeout test or repository integration test proving database
  timeout errors are normalized without weakening transaction atomicity.

## Rollout and Verification

1. Land context resolver and acceptance changes behind existing entry points;
   no feature flag is required because contracts remain backward compatible at
   the public API boundary.
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
- Acceptance invokes `accept_agent_run` once per logical client request.
- A database stall produces a stable retryable failure within the configured
  deadline instead of an indefinite spinner or generic English message.
- No complete JWT, bearer token, Supabase key, or provider API key appears in
  application logs.
- WebSocket and HTTP acceptance paths enforce the same scope and idempotency
  rules.
- Existing Agent authority, tool-boundary, persistence, and canvas-operation
  test suites continue to pass.

