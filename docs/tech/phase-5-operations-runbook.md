# Phase 5 Realtime Operations Runbook

## Deployment contract

- API and Worker both require `SUPABASE_DB_URL`; API startup fails before composition when it is absent.
- Apply `20260822000001_phase5_realtime_events.sql` before deploying the API.
- Railway routes traffic only when `GET /api/health/realtime` returns HTTP 200.
- `GET /api/health` remains a lightweight liveness check and must not be used as realtime readiness.

## Normal behavior

1. `domain_outbox` commits the domain event.
2. The dispatcher appends a durable canvas event and receives its canvas cursor.
3. PostgreSQL emits `loomic_realtime_canvas`; every API replica rereads the event before local fan-out.
4. Each replica reconciles bound canvases every five seconds, so a missed notification is recovered from the durable cursor.
5. Reconnecting clients call `canvas.resume`; a retention gap returns `cursor_gap` and the Web refreshes authoritative canvas state.

## Signals and diagnosis

- `/api/health/realtime` returns 503: the PostgreSQL LISTEN connection is not established. Check `SUPABASE_DB_URL`, database reachability, connection limits, and `realtime listener connected` / `realtime subscriber failed` logs.
- `realtime reconciliation failed`: durable replay RPC is unavailable or returned invalid data. Keep the replica out of readiness until the listener reconnects; clients still recover through resume.
- `realtime reconciliation cursor gap`: retained events no longer cover that replica cursor. The cursor advances and reconnecting clients refresh authoritative state.
- `realtime retention cleanup failed`: event delivery continues, but table growth is no longer bounded. Restore RPC access and verify `prune_realtime_canvas_events` manually.
- Agent lease renewal failure: the runtime invalidates its fence and stops effects. Do not manually clear fencing tokens; allow the persisted recovery path to claim with a newer token.

Logs may include event ID, canvas ID, cursor, run/attempt ID, fencing token, replica/process ID, duration, and outcome. They must not include prompts, event payload bodies, bearer tokens, service keys, signed URLs, or database URLs.

## Retention and recovery

- Cleanup runs at API startup and every 24 hours.
- Rows older than seven days are eligible for deletion, but at least the latest 5000 events per canvas remain.
- `realtime_canvas_cursors` is never pruned, so cursor numbers never restart.
- To pause cross-replica delivery during an incident, stop API notification subscribers; do not delete outbox rows or cursor rows. Durable outbox retry and client resume remain the recovery paths.

## Rollback

Rollback is forward-only for the database. Keep the additive realtime tables/functions, deploy the previous API, and disable subscriber startup if required. Never roll back by deleting `domain_outbox`, `agent_run_attempts`, or realtime cursor rows.
