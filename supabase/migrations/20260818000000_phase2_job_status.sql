-- Phase 2 introduces cooperative cancellation as a first-class state.
-- Keep this in its own migration transaction: PostgreSQL requires a commit
-- before a newly added enum value can be used by later functions.
alter type public.background_job_status
  add value if not exists 'cancel_requested' after 'running';
