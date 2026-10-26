-- Read-only release audit for migrations0022-0024.
-- Queries only migration/catalog metadata: no auth.users, profiles, account
-- keys, feedback content, application RPCs, or other user records are read.
-- Run with: supabase db query --linked --file supabase/tests/audit-release-backend.sql
begin read only;
set local statement_timeout = '30s';
set local lock_timeout = '3s';
set local search_path = public, extensions;

with expected_functions(signature, client_allowed, service_required, definer_required) as (
  values
    ('public.account_access_allow(uuid,text,text)',false,true,true),
    ('public.account_key_status(uuid,text)',false,true,true),
    ('public.account_store_key(uuid,text,text)',false,true,true),
    ('public.account_revoke_key(uuid)',false,true,true),
    ('public.account_lookup_key(text)',false,true,true),
    ('public.account_prepare_transfer(uuid,uuid,text)',false,true,true),
    ('public.account_finish_transfer(uuid,text)',false,true,true),
    ('public.clear_account_access_metadata()',false,false,true),
    ('public.feedback_reserve(uuid,uuid,text,text,text,text)',false,true,true),
    ('public.feedback_finish(uuid,uuid,uuid,uuid)',false,true,true),
    ('public.feedback_release(uuid,uuid,uuid)',false,true,true),
    ('public.set_shared_app_limits(jsonb,integer,uuid)',true,null,true),
    ('public.set_shared_daily_total(integer,uuid)',true,null,true),
    ('public.get_circle_app_limits()',true,null,true),
    ('public.camp_hat_price(text)',false,null,false),
    ('public.camp_catalog_v4_shop(jsonb)',false,null,false),
    ('public.camp_catalog_v4_character(jsonb)',false,null,false),
    ('public.camp_check_character_unlock()',false,null,true),
    ('public.camp_reconcile_character(uuid,uuid)',false,null,true),
    ('public.camp_character(public.profiles)',false,null,true),
    ('public.update_my_character(uuid,text,text,integer,text)',true,null,true),
    ('public.get_circle_shop_v4(text)',true,null,true),
    ('public.get_circle_shop_v5(text)',true,null,true),
    ('public.get_app_snapshot_v4(text)',true,null,true),
    ('public.get_app_snapshot_v5(text)',true,null,true),
    ('public.purchase_circle_item_v4(uuid,text,integer)',true,null,true),
    ('public.purchase_circle_item_v5(uuid,text,integer)',true,null,true),
    ('public.set_circle_background_v4(uuid,text)',true,null,true),
    ('public.set_circle_background_v5(uuid,text)',true,null,true),
    ('public.join_shared_circle_v4(text)',true,null,true),
    ('public.join_shared_circle_v5(text)',true,null,true)
), function_checks as (
  select e.signature, p.oid is not null as present,
    coalesce(not has_function_privilege('anon',p.oid,'EXECUTE'),false) as anonymous_denied,
    coalesce(has_function_privilege('authenticated',p.oid,'EXECUTE') = e.client_allowed,false) as client_access_correct,
    coalesce(e.service_required is null or has_function_privilege('service_role',p.oid,'EXECUTE') = e.service_required,false) as service_access_correct,
    coalesce(p.prosecdef = e.definer_required,false) as security_mode_correct,
    coalesce(p.proconfig @> array['search_path=""']::text[],false) as search_path_pinned
  from expected_functions e left join pg_proc p on p.oid = to_regprocedure(e.signature)
), expected_tables(name, client_select) as (
  values ('account_recovery_keys',false),('account_recovery_transfers',false),
    ('account_access_attempts',false),('feedback_reports',false),('shared_app_limits',true)
), table_checks as (
  select e.name, c.oid is not null as present, coalesce(c.relrowsecurity,false) as rls_enabled,
    coalesce(not has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE'),false) as anonymous_denied,
    coalesce(has_table_privilege('authenticated',c.oid,'SELECT') = e.client_select,false) as client_read_correct,
    coalesce(not has_table_privilege('authenticated',c.oid,'INSERT,UPDATE,DELETE'),false) as client_writes_denied,
    coalesce(e.client_select or not has_table_privilege('service_role',c.oid,'SELECT,INSERT,UPDATE,DELETE'),false) as private_table_direct_service_denied
  from expected_tables e left join pg_class c on c.oid = to_regclass('public.' || e.name)
)
select jsonb_build_object(
  'migrations', (select jsonb_agg(jsonb_build_object('version',version,'name',name) order by version)
    from supabase_migrations.schema_migrations),
  'requiredMigrationsPresent', (select count(*)=3 from supabase_migrations.schema_migrations where version in ('0022','0023','0024')),
  'functions', (select jsonb_agg(to_jsonb(f) order by signature) from function_checks f),
  'allFunctionChecksPass', (select bool_and(present and anonymous_denied and client_access_correct and service_access_correct and security_mode_correct and search_path_pinned) from function_checks),
  'tables', (select jsonb_agg(to_jsonb(t) order by name) from table_checks t),
  'allTableChecksPass', (select bool_and(present and rls_enabled and anonymous_denied and client_read_correct and client_writes_denied and private_table_direct_service_denied) from table_checks),
  'sharedLimitsPolicy', (select jsonb_agg(jsonb_build_object('name',policyname,'roles',roles,'command',cmd,'using',qual))
    from pg_policies where schemaname='public' and tablename='shared_app_limits'),
  'constraints', (select jsonb_agg(jsonb_build_object('name',co.conname,'definition',pg_get_constraintdef(co.oid)) order by co.conname)
    from pg_constraint co join pg_namespace n on n.oid=co.connamespace
    where n.nspname='public' and co.conname in ('decision_fields_match_status','profiles_character_shape','camp_group_unlocks_item_id_check','camp_group_unlocks_cost_check')),
  'accountMetadataCleanupTrigger', (select jsonb_agg(jsonb_build_object('name',t.tgname,'enabled',t.tgenabled,'definition',pg_get_triggerdef(t.oid)))
    from pg_trigger t where t.tgname='clear_account_access_metadata' and not t.tgisinternal)
) as release_audit;

commit;
