begin;

create extension if not exists pgtap with schema extensions;
select plan(10);

select hasnt_table('public', 'skill_files', 'dynamic Skill files are removed');
select hasnt_table('public', 'workspace_skills', 'workspace Skill installs are removed');
select hasnt_table('public', 'skills', 'dynamic Skill registry is removed');
select hasnt_function('public', 'init_workspace_skills', array[]::text[],
  'workspace Skill auto-install function is removed');
select hasnt_function('public', 'update_skills_updated_at', array[]::text[],
  'dynamic Skill timestamp function is removed');
select is((select count(*)::integer from pg_trigger
  where tgname in ('trg_init_workspace_skills', 'skill_files_updated_at',
    'skills_updated_at') and not tgisinternal), 0,
  'dynamic Skill triggers are removed');
select is((select count(*)::integer from pg_indexes
  where schemaname = 'public' and indexname in (
    'skills_category_idx', 'skills_source_idx', 'skills_created_by_idx',
    'workspace_skills_workspace_idx', 'skill_files_skill_id_idx'
  )), 0, 'dynamic Skill indexes are removed');
select is((select count(*)::integer from pg_policies
  where schemaname = 'public' and tablename in (
    'skills', 'workspace_skills', 'skill_files'
  )), 0, 'dynamic Skill policies are removed');
select ok(to_regclass('public.skills') is null,
  'no compatibility relation preserves the Skill registry');
select ok(to_regclass('public.workspace_skills') is null,
  'no compatibility relation preserves Skill installation data');

select * from finish();
rollback;
