-- Resource authorization uses the caller-scoped client so RLS remains the
-- source of truth. Grant only the reads needed to resolve canvas/session
-- ownership; server-owned run bookkeeping remains service-role only.

grant select on table public.canvases to authenticated;
grant select on table public.chat_sessions to authenticated;

-- chat_sessions policies join these tenant tables while evaluating access.
grant select on table public.projects to authenticated;
grant select on table public.workspace_members to authenticated;
