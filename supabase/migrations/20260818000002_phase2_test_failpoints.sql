-- Local-owner-only transaction failpoints used by real PostgreSQL integration tests.
-- PostgREST sessions cannot activate them because session_user differs from the
-- SECURITY DEFINER function owner.
create or replace function public.phase2_raise_test_failpoint()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_failpoint text;
begin
  if current_user <> 'postgres' or session_user <> 'postgres' then
    return coalesce(new, old);
  end if;
  v_failpoint := current_setting('loomic.test_failpoint', true);
  if v_failpoint is null or v_failpoint = '' then
    return coalesce(new, old);
  end if;

  if tg_table_name = 'credit_transactions' and tg_op = 'INSERT' then
    if v_failpoint = 'after_debit' and new.transaction_type = 'generation_deduct' then
      raise exception using errcode = 'P0001', message = 'PHASE2_TEST_FAILPOINT', detail = v_failpoint;
    end if;
  elsif tg_table_name = 'background_jobs' and tg_op = 'INSERT' then
    if v_failpoint = 'before_enqueue' then
      raise exception using errcode = 'P0001', message = 'PHASE2_TEST_FAILPOINT', detail = v_failpoint;
    end if;
  end if;

  if tg_table_name = 'background_jobs' and tg_op = 'UPDATE' then
    if v_failpoint = 'before_job_settle_commit'
       and new.status in ('succeeded', 'failed', 'canceled', 'dead_letter') then
      raise exception using errcode = 'P0001', message = 'PHASE2_TEST_FAILPOINT', detail = v_failpoint;
    end if;
  elsif tg_table_name = 'canvases' and tg_op = 'UPDATE' then
    if v_failpoint = 'before_canvas_commit' and new.revision <> old.revision then
      raise exception using errcode = 'P0001', message = 'PHASE2_TEST_FAILPOINT', detail = v_failpoint;
    end if;
  elsif tg_table_name = 'domain_outbox' and tg_op = 'UPDATE' then
    if v_failpoint = 'after_outbox_claim'
       and old.locked_at is null and new.locked_at is not null then
      raise exception using errcode = 'P0001', message = 'PHASE2_TEST_FAILPOINT', detail = v_failpoint;
    end if;
  end if;
  return coalesce(new, old);
end;
$$;

revoke all on function public.phase2_raise_test_failpoint() from public, anon, authenticated, service_role;

create trigger phase2_failpoint_after_debit
after insert on public.credit_transactions
for each row execute function public.phase2_raise_test_failpoint();

create trigger phase2_failpoint_before_enqueue
before insert on public.background_jobs
for each row execute function public.phase2_raise_test_failpoint();

create trigger phase2_failpoint_before_job_settle
before update on public.background_jobs
for each row execute function public.phase2_raise_test_failpoint();

create trigger phase2_failpoint_before_canvas_commit
before update on public.canvases
for each row execute function public.phase2_raise_test_failpoint();

create trigger phase2_failpoint_after_outbox_claim
after update on public.domain_outbox
for each row execute function public.phase2_raise_test_failpoint();
