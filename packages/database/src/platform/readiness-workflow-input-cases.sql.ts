/** Additive case tables are API-only and forced tenant RLS; cleanup is maintenance-only. */
export const READINESS_WORKFLOW_INPUT_CASES_SQL = `(
  (select count(*)=3 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='app' and c.relname=any(array['workflow_input_cases','workflow_input_case_payloads','workflow_input_case_receipts'])
      and c.relowner=(select oid from pg_roles where rolname=$1) and c.relrowsecurity and c.relforcerowsecurity
      and has_table_privilege($3,c.oid,'SELECT') and has_table_privilege($3,c.oid,'INSERT')
      and not has_table_privilege($3,c.oid,'DELETE') and not has_table_privilege($3,c.oid,'TRUNCATE')
      and not has_table_privilege($2,c.oid,'SELECT')
      and not exists(select 1 from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
        where a.grantee not in (c.relowner,(select oid from pg_roles where rolname=$3)))
      and exists(select 1 from pg_policy p where p.polrelid=c.oid and p.polname=c.relname||'_tenant'
        and p.polroles=array[(select oid from pg_roles where rolname=$3)]::oid[] and p.polcmd='*'
        and pg_get_expr(p.polqual,p.polrelid)='((workspace_id)::text = NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text))'
        and pg_get_expr(p.polwithcheck,p.polrelid)=pg_get_expr(p.polqual,p.polrelid))
      and (select count(*) from pg_policy p where p.polrelid=c.oid)=2
      and exists(select 1 from pg_policy p where p.polrelid=c.oid and p.polname=c.relname||'_owner'
        and p.polroles=array[(select oid from pg_roles where rolname=$1)]::oid[] and p.polcmd='*'
        and pg_get_expr(p.polqual,p.polrelid)='true' and pg_get_expr(p.polwithcheck,p.polrelid)='true')
      and exists(select 1 from pg_trigger t where t.tgrelid=c.oid and not t.tgisinternal and t.tgenabled='O'
        and t.tgfoid=to_regprocedure('app.guard_workflow_input_case_write()'))
  )
  and (select array_agg(a.attname||':'||format_type(a.atttypid,a.atttypmod) order by a.attnum)
    from pg_attribute a where a.attrelid=to_regclass('app.workflow_input_cases') and a.attnum>0 and not a.attisdropped)
    =array['id:uuid','workspace_id:uuid','workflow_id:uuid','workflow_version_id:uuid','version_checksum:character varying(77)','name:character varying(128)','revision:integer','created_at:timestamp with time zone','updated_at:timestamp with time zone','deleted_at:timestamp with time zone']::text[]
  and (select array_agg(a.attname||':'||format_type(a.atttypid,a.atttypmod) order by a.attnum)
    from pg_attribute a where a.attrelid=to_regclass('app.workflow_input_case_payloads') and a.attnum>0 and not a.attisdropped)
    =array['workspace_id:uuid','case_id:uuid','revision:integer','input:text','canonical_bytes:integer','created_at:timestamp with time zone']::text[]
  and (select array_agg(a.attname||':'||format_type(a.atttypid,a.atttypmod) order by a.attnum)
    from pg_attribute a where a.attrelid=to_regclass('app.workflow_input_case_receipts') and a.attnum>0 and not a.attisdropped)
    =array['workspace_id:uuid','actor_id:uuid','workflow_id:uuid','operation:character varying(8)','key_hash:character(64)','request_hash:character(64)','case_id:uuid','revision:integer','created_at:timestamp with time zone','expires_at:timestamp with time zone']::text[]
  and exists(select 1 from pg_index i where i.indexrelid=to_regclass('app.workflow_input_cases_page_idx') and i.indisvalid and i.indisready)
  and exists(select 1 from pg_index i where i.indexrelid=to_regclass('app.workflow_input_case_receipts_expiry_idx') and i.indisvalid and i.indisready)
  and (select count(*) from pg_constraint c where c.conrelid=to_regclass('app.workflow_input_cases') and c.contype='f' and c.convalidated)=2
  and (select count(*) from pg_constraint c where c.conrelid=to_regclass('app.workflow_input_case_payloads') and c.contype='f' and c.convalidated)=1
  and exists(select 1 from pg_proc p where p.oid=to_regprocedure('app.guard_workflow_input_case_write()')
    and p.proowner=(select oid from pg_roles where rolname=$1) and p.prosecdef
    and md5(p.prosrc)='a3108e59e200d8e251cf39c056f41dd9'
    and p.proconfig=array['search_path=pg_catalog, pg_temp','row_security=on']::text[]
    and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee<>p.proowner))
  and exists(select 1 from pg_proc p where p.oid=to_regprocedure('app.reap_workflow_input_cases(integer)')
    and p.proowner=(select oid from pg_roles where rolname=$1) and p.prosecdef
    and p.proconfig=array['search_path=pg_catalog, pg_temp','row_security=on']::text[]
    and md5(p.prosrc)='f5a5951bcb6a7d913dac66dc15702e25'
    and not has_function_privilege($3,p.oid,'EXECUTE') and not has_function_privilege($2,p.oid,'EXECUTE')
    and has_function_privilege($4::name,p.oid,'EXECUTE')
    and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      where a.grantee not in (p.proowner,(select oid from pg_roles where rolname=$4))))
  and exists(select 1 from pg_proc p where p.oid=to_regprocedure('app.execute_workspace_tenant_rows_page(uuid,uuid,bigint,integer,bigint,character)')
    and p.proowner=(select oid from pg_roles where rolname=$1) and p.prosecdef
    and md5(p.prosrc)='348588ea384effc589d6c8c74686aa58'
    and p.proconfig=array['search_path=pg_catalog, pg_temp','row_security=on']::text[]
    and has_function_privilege($4::name,p.oid,'EXECUTE')
    and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      where a.grantee not in (p.proowner,(select oid from pg_roles where rolname=$4))))
)`;
