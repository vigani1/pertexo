// ADR060 additive API-only creator; all source/receipt checks retain tenant RLS.
export const READINESS_WORKFLOW_DUPLICATION_SQL = `(
  select coalesce(exists(
    select 1 from pg_proc command
      where command.oid=to_regprocedure('app.create_workflow_duplicate_draft(uuid,uuid,uuid,uuid,character varying,integer,jsonb,character,character,text,uuid)')
        and command.proowner=(select oid from pg_roles where rolname=$1)
        and command.prosecdef and command.provolatile='v'
        and command.proconfig=array['search_path=pg_catalog, pg_temp','row_security=on']::text[]
        and md5(command.prosrc)='cca6cf717f5528c781f30c2460fe9dca'
        and has_function_privilege($3,command.oid,'EXECUTE')
        and not exists(select 1 from aclexplode(coalesce(command.proacl,acldefault('f',command.proowner))) privilege
          where privilege.grantee<>command.proowner
            and privilege.grantee<>(select oid from pg_roles where rolname=$3))
  ),false)
)`;
