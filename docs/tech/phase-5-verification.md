# Phase 5 Verification

Date: 2026-08-21

## Result

Phase 5 is complete and accepted. ENG-032 is resolved: canvas replay and active Agent lookup use PostgreSQL authority; database notification is only a wake-up hint; replica-local connection and RPC state are not durable authority.

## Evidence

- Pinned Supabase CLI full reset: PASS; all historical migrations plus `20260822000001_phase5_realtime_events.sql` applied.
- Phase 5 pgTAP: PASS, 18/18.
- Full pgTAP: PASS, 7 files and 175/175 assertions.
- Generated-asset reliability regression: PASS, 30/30 after the forward fix in `20260822000002_fix_resolved_attachment_template.sql`.
- Real PostgreSQL integration: PASS, 3/3; concurrent cursor allocation, committed LISTEN/NOTIFY, replica A to replica B socket fan-out, and replay through a new store instance.
- `pnpm ci:check`: PASS.
- Workspace governance: 88/88.
- Server: 486 passed, 10 database-gated tests skipped in the ordinary package run; the Phase 5 PostgreSQL suite was run separately and passed 3/3.
- Web: 146/146. Shared: 61/61. Config: 26/26.
- Production Server and Next.js builds: PASS.

## Database follow-up

The aggregate suite initially exposed a pre-existing automatic-placement wrapper defect: it computed server-authoritative coordinates but delegated the caller's stale coordinates to the strict finalizer. The forward migration `20260822000002_fix_resolved_attachment_template.sql` merges only the resolved geometry into the delegated template. Explicit-placement tampering remains rejected by the legacy finalizer. The original failing suite now passes 30/30 and the aggregate suite passes 175/175.

## Operational acceptance

- API deployment requires `SUPABASE_DB_URL` and Railway uses `/api/health/realtime` readiness.
- Listener start/stop, five-second missed-notification reconciliation, cursor-gap logging, and daily retention cleanup are explicit and bounded.
- Run ownership continues to use Phase 3 lease renewal and fencing RPCs; no duplicate Phase 5 lease authority was added.
- Operations procedures are documented in `docs/tech/phase-5-operations-runbook.md`.
