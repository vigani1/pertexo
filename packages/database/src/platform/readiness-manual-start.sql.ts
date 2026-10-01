/** Checked admission's all-writer fence is required even while case rollout is off. */
export const READINESS_MANUAL_START_SQL = `(
  exists(select 1 from pg_class c where c.oid=to_regclass('app.workflow_manual_start_rejections')
    and c.relowner=(select oid from pg_roles where rolname=$1) and c.relrowsecurity and c.relforcerowsecurity
    and has_table_privilege($3,c.oid,'SELECT') and has_table_privilege($3,c.oid,'INSERT')
    and not has_table_privilege($3,c.oid,'UPDATE') and not has_table_privilege($3,c.oid,'DELETE')
    and not has_table_privilege($2,c.oid,'SELECT')
    and not exists(select 1 from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
      where a.grantee not in (c.relowner,(select oid from pg_roles where rolname=$3)))
    and (select count(*) from pg_policy p where p.polrelid=c.oid)=2
    and exists(select 1 from pg_policy p where p.polrelid=c.oid and p.polname='workflow_manual_start_rejections_owner'
      and p.polroles=array[c.relowner]::oid[] and p.polcmd='*'
      and pg_get_expr(p.polqual,p.polrelid)='true' and pg_get_expr(p.polwithcheck,p.polrelid)='true')
    and exists(select 1 from pg_policy p where p.polrelid=c.oid and p.polname='workflow_manual_start_rejections_tenant'
      and p.polroles=array[(select oid from pg_roles where rolname=$3)]::oid[] and p.polcmd='*'
      and pg_get_expr(p.polqual,p.polrelid)='((workspace_id)::text = NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text))'
      and pg_get_expr(p.polwithcheck,p.polrelid)=pg_get_expr(p.polqual,p.polrelid))
    and (select array_agg(a.attname::text||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull::text order by a.attnum)
      from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped)=array[
      'workspace_id:uuid:true','workflow_id:uuid:true','scope:character varying(128):true',
      'key_hash:character(64):true','request_hash:character(64):true','expected_version_id:uuid:true',
      'observed_version_id:uuid:true','created_at:timestamp with time zone:true','expires_at:timestamp with time zone:true']::text[]
    and exists(select 1 from pg_index i where i.indrelid=c.oid and i.indisvalid and i.indisready
      and i.indexrelid=to_regclass('app.workflow_manual_start_rejections_expiry_idx')
      and pg_get_indexdef(i.indexrelid)='CREATE INDEX workflow_manual_start_rejections_expiry_idx ON app.workflow_manual_start_rejections USING btree (expires_at, workspace_id, scope, key_hash)'))
  and exists(select 1 from pg_proc p where p.oid=to_regprocedure('app.lock_manual_workflow_run_start(uuid,uuid,text,text)')
    and p.proowner=(select oid from pg_roles where rolname=$1) and p.prosecdef
    and p.proconfig=array['search_path=pg_catalog, pg_temp','row_security=on']::text[]
    and md5(p.prosrc)='e70f076dbfffbb8a79b4534b49bdc138'
    and has_function_privilege($3,p.oid,'EXECUTE')
    and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      where a.grantee not in(p.proowner,(select oid from pg_roles where rolname=$3))))
  and exists(select 1 from pg_proc p where p.oid=to_regprocedure('app.enforce_manual_start_writer()')
    and p.proowner=(select oid from pg_roles where rolname=$1) and not p.prosecdef
    and p.proconfig=array['search_path=pg_catalog, pg_temp']::text[]
    and md5(p.prosrc)='a24d51f06dfe43548064394c9bf03ca9'
    and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee<>p.proowner))
  and exists(select 1 from pg_trigger t where t.tgrelid=to_regclass('app.workflow_runs')
    and t.tgname='manual_start_writer_fence' and t.tgenabled='O' and not t.tgisinternal
    and t.tgtype=7 and t.tgfoid=to_regprocedure('app.enforce_manual_start_writer()'))
  and exists(select 1 from pg_proc p where p.oid=to_regprocedure('app.assert_workflow_input_cases_enabled()')
    and p.proowner=(select oid from pg_roles where rolname=$1) and p.prosecdef
    and p.proconfig=array['search_path=pg_catalog, pg_temp','row_security=on']::text[]
    and md5(p.prosrc)='f537940438bedfc091e8a19b64c01689'
    and has_function_privilege($3,p.oid,'EXECUTE')
    and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      where a.grantee not in(p.proowner,(select oid from pg_roles where rolname=$3))))
  and exists(select 1 from pg_proc p where p.oid=to_regprocedure('app.prune_manual_start_rejections(integer)')
    and p.proowner=(select oid from pg_roles where rolname=$1) and p.prosecdef
    and p.proconfig=array['search_path=pg_catalog, pg_temp','row_security=on']::text[]
    and md5(p.prosrc)='490686b5af7560b8c7d0a6f526762fe2'
    and not has_function_privilege($3,p.oid,'EXECUTE') and not has_function_privilege($2,p.oid,'EXECUTE')
    and has_function_privilege($4::name,p.oid,'EXECUTE')
    and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      where a.grantee not in(p.proowner,(select oid from pg_roles where rolname=$4::name))))
  and exists(select 1 from pg_class c where c.oid=to_regclass('app.workflow_input_case_rollout')
    and c.relowner=(select oid from pg_roles where rolname=$1)
    and has_table_privilege($5::name,c.oid,'SELECT') and has_table_privilege($5::name,c.oid,'UPDATE')
    and not has_table_privilege($5::name,c.oid,'INSERT') and not has_table_privilege($5::name,c.oid,'DELETE')
    and not exists(select 1 from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
      where a.grantee not in(c.relowner,(select oid from pg_roles where rolname=$5::name)))
    and not has_table_privilege($3,c.oid,'SELECT') and not has_table_privilege($3,c.oid,'UPDATE')
    and not has_table_privilege($2,c.oid,'SELECT') and not has_table_privilege($2,c.oid,'UPDATE'))
)`;
