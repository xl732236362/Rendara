-- Phase 3 permanently removes the user-extensible Skill data model.
-- Built-in Skills are loaded only from the server-owned manifest and files.

drop trigger if exists trg_init_workspace_skills on public.workspaces;
drop trigger if exists skill_files_updated_at on public.skill_files;
drop trigger if exists skills_updated_at on public.skills;

drop function if exists public.init_workspace_skills();
drop function if exists public.update_skills_updated_at();

drop table if exists public.skill_files;
drop table if exists public.workspace_skills;
drop table if exists public.skills;
