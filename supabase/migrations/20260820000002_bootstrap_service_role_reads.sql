-- Allow the server-only viewer bootstrap boundary to read the rows returned by
-- bootstrap_viewer. Write access remains confined to security-definer RPCs.

grant select on table public.profiles to service_role;
grant select on table public.workspaces to service_role;
grant select on table public.workspace_members to service_role;

-- Authenticated requests still pass through row-level security. These grants
-- only make the existing own-profile and workspace-membership policies usable.
grant select, update on table public.profiles to authenticated;
grant select on table public.workspaces to authenticated;
grant update on table public.projects to authenticated;
grant insert, update, delete on table public.chat_sessions to authenticated;
grant select, insert, delete on table public.chat_messages to authenticated;
