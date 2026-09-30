// Narrow ADR 056 owner command, with no direct API authority on private state.
export const AUTO_PAUSE_AUTHORITY_SQL = `(
  (select count(*)=20 from pg_attribute where attrelid=to_regclass('app.workflows') and attnum>0 and not attisdropped)
  and
  exists(select 1 from pg_proc command
    where command.oid=to_regprocedure('app.workflow_auto_pause_control(uuid,uuid,uuid,text,jsonb,text,text,text,text)')
      and pg_get_userbyid(command.proowner)=$1 and command.prosecdef
      and md5(command.prosrc)='8753b78e91a138add46bac4807553bbd'
      and command.proconfig=array['search_path=pg_catalog, app, pg_temp','row_security=on']
      and has_function_privilege($3,command.oid,'EXECUTE')
      and not exists(select 1 from aclexplode(coalesce(command.proacl,acldefault('f',command.proowner))) acl
        where acl.privilege_type='EXECUTE' and acl.grantee<>command.proowner
          and acl.grantee<>(select oid from pg_roles where rolname=$3)))
  and not exists(select 1 from (values
    ('workflow_auto_pause_command_receipts'),('workflow_failure_streaks'),('workflow_trigger_outcomes')
  ) required(table_name) where not exists(select 1 from pg_class table_class
    where table_class.oid=to_regclass('app.'||required.table_name)
      and pg_get_userbyid(table_class.relowner)=$1 and table_class.relrowsecurity and table_class.relforcerowsecurity
      and not has_table_privilege($3,table_class.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')))
  and exists(select 1 from pg_policy policy
    where policy.polrelid=to_regclass('app.workflow_auto_pause_command_receipts')
      and policy.polname='workflow_auto_pause_receipts_owner' and policy.polcmd='*'
      and policy.polroles=array[(select oid from pg_roles where rolname=$1)]
      and pg_get_expr(policy.polqual,policy.polrelid)='true'
      and pg_get_expr(policy.polwithcheck,policy.polrelid)='true')
  and (select count(*)=1 from pg_policy where polrelid=to_regclass('app.workflow_auto_pause_command_receipts'))
  and not has_table_privilege($2,'app.workflow_auto_pause_command_receipts','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
)`;
