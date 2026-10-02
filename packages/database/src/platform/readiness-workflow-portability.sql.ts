// ADR062: readers may run with the writer off. Pin the creator and gate ACL,
// not an enabled value; production activation is a separate authorized action.
export const READINESS_WORKFLOW_PORTABILITY_SQL = `(
  exists(select 1 from pg_proc command
    where command.oid=to_regprocedure('app.create_workflow_import_draft(uuid,uuid,uuid,jsonb,character,character,text)')
      and command.proowner=(select oid from pg_roles where rolname=$1)
      and command.prosecdef and command.provolatile='v'
      and command.proconfig=array['search_path=pg_catalog, pg_temp','row_security=on']::text[]
      and md5(command.prosrc)='b6a6e87c4bed5ae35b3edc927a40f4e4'
      and has_function_privilege($3,command.oid,'EXECUTE')
      and not exists(select 1 from aclexplode(coalesce(command.proacl,acldefault('f',command.proowner))) privilege
        where privilege.grantee<>command.proowner
          and privilege.grantee<>(select oid from pg_roles where rolname=$3)))
  and exists(select 1 from pg_proc reader
    where reader.oid=to_regprocedure('app.lock_workflow_portable_version(uuid,uuid,uuid,uuid)')
      and reader.proowner=(select oid from pg_roles where rolname=$1)
      and reader.prosecdef and reader.provolatile='v'
      and reader.proconfig=array['search_path=pg_catalog, pg_temp','row_security=on']::text[]
      and md5(reader.prosrc)='00c1b41bf997942d194f9af7819f4d15'
      and has_function_privilege($3,reader.oid,'EXECUTE')
      and not exists(select 1 from aclexplode(coalesce(reader.proacl,acldefault('f',reader.proowner))) privilege
        where privilege.grantee<>reader.proowner
          and privilege.grantee<>(select oid from pg_roles where rolname=$3)))
  and exists(select 1 from pg_class gate where gate.oid=to_regclass('app.workflow_portability_rollout')
    and gate.relowner=(select oid from pg_roles where rolname=$1))
  and (select count(*)=2 from pg_attribute where attrelid=to_regclass('app.workflow_portability_rollout') and attnum>0 and not attisdropped)
  and exists(select 1 from pg_attribute where attrelid=to_regclass('app.workflow_portability_rollout') and attname='singleton' and atttypid='boolean'::regtype and attnotnull)
  and exists(select 1 from pg_attribute where attrelid=to_regclass('app.workflow_portability_rollout') and attname='import_enabled' and atttypid='boolean'::regtype and attnotnull)
  and exists(select 1 from pg_constraint where conrelid=to_regclass('app.workflow_portability_rollout') and contype='p' and pg_get_constraintdef(oid)='PRIMARY KEY (singleton)')
  and exists(select 1 from pg_constraint where conrelid=to_regclass('app.workflow_portability_rollout') and contype='c' and pg_get_constraintdef(oid)='CHECK (singleton)')
  and not exists(select 1 from pg_attribute column_grant,
    lateral aclexplode(column_grant.attacl) privilege
    where column_grant.attrelid=to_regclass('app.workflow_portability_rollout')
      and privilege.grantee<>(select oid from pg_roles where rolname=$1)
      and (privilege.grantee<>(select oid from pg_roles where rolname=$3)
        or column_grant.attname<>'singleton' or privilege.privilege_type<>'UPDATE' or privilege.is_grantable))
  and has_table_privilege($3,'app.workflow_portability_rollout','SELECT')
  and has_column_privilege($3,'app.workflow_portability_rollout','singleton','UPDATE')
  and not has_column_privilege($3,'app.workflow_portability_rollout','import_enabled','UPDATE')
  and not has_table_privilege($3,'app.workflow_portability_rollout','INSERT,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  and not exists(select 1 from pg_class gate,
    lateral aclexplode(coalesce(gate.relacl,acldefault('r',gate.relowner))) privilege
    where gate.oid=to_regclass('app.workflow_portability_rollout')
      and privilege.grantee<>gate.relowner
      and privilege.grantee<>(select oid from pg_roles where rolname=$3))
)`;
