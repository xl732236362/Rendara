-- Keep the shared deferred constraint trigger compatible with both row types.
-- A CASE expression resolves every NEW field against the active trigger record,
-- so agent_runs rows cannot safely reference the attempts-only run_id field.
create or replace function public.assert_agent_terminal_alignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.agent_runs%rowtype;
  v_attempt public.agent_run_attempts%rowtype;
  v_run_id uuid;
begin
  if tg_table_schema = 'public' and tg_table_name = 'agent_runs' then
    v_run_id := new.id;
  elsif tg_table_schema = 'public' and tg_table_name = 'agent_run_attempts' then
    v_run_id := new.run_id;
  else
    raise exception 'agent_terminal_alignment_trigger_misconfigured';
  end if;

  select * into v_run
  from public.agent_runs
  where id = v_run_id;

  if not found then
    return null;
  end if;

  select * into v_attempt
  from public.agent_run_attempts
  where run_id = v_run.id
    and attempt_id = v_run.current_attempt_id;

  if not found
     or v_run.status <> v_attempt.status
     or v_run.completed_at is distinct from v_attempt.completed_at then
    raise exception 'agent_terminal_invariant_violation';
  end if;

  return null;
end;
$$;
