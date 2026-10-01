// ADR059 worker capability boundary; startup checks do not activate enforce mode.
export const READINESS_CONNECTION_HEALTH_SQL = `(
  with boundary_roles as (
    select (select oid from pg_roles where rolname=$1) owner_id,
      (select oid from pg_roles where rolname=$2) worker_id,
      (select oid from pg_roles where rolname=$3) api_id
  ) select coalesce(
    owner_id is not null and worker_id is not null and api_id is not null
    and not exists(select 1 from (values
      ('app.enforce_connection_health_protocol()','4b36377613e407ba046e8c9c8f9ee824',false,false),
      ('app.cleanup_connection_health_command()','3356eaa54a79e4c96e55d258621c6fea',true,false),
      ('app.bind_node_attempt_connection_dispatch(uuid,uuid,text,bigint,uuid,uuid)','a63cdd2cf7a8e9c967b992f9df28ed30',true,true),
      ('app.record_node_attempt_connection_health(uuid,uuid,text,bigint,text,text,text,uuid,uuid)','abded4cdf7da724dce322df3801262c5',true,true),
      ('app.apply_connection_health_observation(uuid,uuid,text,uuid,text)','2a15128a645b16ac211456c880d2cfd2',true,true),
      ('app.audit_connection_secret_access(uuid,uuid,uuid,text,text,text,text)','62ddece0876f51039e5825ac914246d3',true,true)
    ) expected(signature,hash,definer,worker_execute) where not exists(
      select 1 from pg_proc command where command.oid=to_regprocedure(expected.signature)
        and command.proowner=owner_id and command.prosecdef=expected.definer and command.provolatile='v'
        and md5(command.prosrc)=expected.hash
        and command.proconfig=case when expected.definer then array['search_path=pg_catalog, app','row_security=on']::text[]
          else array['search_path=pg_catalog, app']::text[] end
        and has_function_privilege(worker_id,command.oid,'EXECUTE')=expected.worker_execute
        and not exists(select 1 from aclexplode(coalesce(command.proacl,acldefault('f',command.proowner))) privilege
          where privilege.grantee<>owner_id and (not expected.worker_execute or privilege.grantee<>worker_id))))
    and not exists(select 1 from (values
      ('node_attempt_connection_dispatches',9),('connection_health_observations',9)
    ) expected(name,columns) where not exists(
      select 1 from pg_class relation where relation.oid=to_regclass('app.'||expected.name)
        and relation.relowner=owner_id and relation.relrowsecurity and relation.relforcerowsecurity
        and (select count(*)=expected.columns from pg_attribute where attrelid=relation.oid and attnum>0 and not attisdropped)
        and (select count(*)=1 from pg_policy where polrelid=relation.oid)
        and exists(select 1 from pg_policy policy where policy.polrelid=relation.oid
          and policy.polname=expected.name||'_workspace_scope' and policy.polcmd='*' and policy.polpermissive
          and cardinality(policy.polroles)=2 and owner_id=any(policy.polroles) and worker_id=any(policy.polroles)
          and pg_get_expr(policy.polqual,policy.polrelid)='((workspace_id)::text = NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text))'
          and pg_get_expr(policy.polwithcheck,policy.polrelid)=pg_get_expr(policy.polqual,policy.polrelid))
        and has_table_privilege(worker_id,relation.oid,'SELECT')
        and not has_any_column_privilege(worker_id,relation.oid,'INSERT,UPDATE,REFERENCES')
        and not has_table_privilege(worker_id,relation.oid,'DELETE,TRUNCATE,TRIGGER')
        and not exists(select 1 from aclexplode(coalesce(relation.relacl,acldefault('r',relation.relowner))) privilege
          where privilege.grantee<>owner_id and (privilege.grantee<>worker_id or privilege.privilege_type<>'SELECT'))
        and not exists(select 1 from pg_attribute attribute,
          lateral aclexplode(attribute.attacl) privilege
          where attribute.attrelid=relation.oid and attribute.attnum>0 and not attribute.attisdropped
            and privilege.grantee<>owner_id)))
    and exists(select 1 from pg_attribute where attrelid=to_regclass('app.connections') and attname='health_revision'
      and atttypid='bigint'::regtype and attnotnull and not attisdropped)
    and not exists(select 1 from (values('last_run_observed_at','timestamp with time zone'),
      ('last_health_transition_at','timestamp with time zone'),('last_health_transition_source','character varying(16)')) expected(name,type)
      where not exists(select 1 from pg_attribute attribute where attribute.attrelid=to_regclass('app.connections')
        and attribute.attname=expected.name and not attribute.attisdropped and not attribute.attnotnull
        and format_type(attribute.atttypid,attribute.atttypmod)=expected.type))
    and exists(select 1 from pg_proc where oid=to_regprocedure('app.apply_workspace_deletion_side_effects()')
      and proowner=owner_id and prosecdef and md5(prosrc)='908becdc3d5fbf1ec9a1a855c97c75bf'
      and proconfig=array['search_path=pg_catalog, app, pg_temp','row_security=on']::text[])
    and exists(select 1 from pg_proc where oid=to_regprocedure('app.reject_retention_batch_direct_mutation()')
      and proowner=owner_id and not prosecdef and md5(prosrc)='bd7d508fdf10cf97eb33467e8bd00f37'
      and proconfig=array['search_path=pg_catalog, pg_temp']::text[])
    and not has_any_column_privilege(worker_id,'app.connections','UPDATE')
    and not has_table_privilege(worker_id,'app.connection_events','INSERT')
    and has_column_privilege(api_id,'app.connections','health_revision','UPDATE')
    and exists(select 1 from pg_proc command where command.oid=to_regprocedure('app.lock_notification_connection(uuid,uuid)')
      and command.proowner=owner_id and command.prosecdef and command.provolatile='v'
      and md5(command.prosrc)='a12fd79c0d2753ff214e864732ed1ca3'
      and command.proconfig=array['search_path=pg_catalog, app','row_security=on']::text[]
      and has_function_privilege(api_id,command.oid,'EXECUTE')
      and has_function_privilege(worker_id,command.oid,'EXECUTE')
      and not exists(select 1 from aclexplode(coalesce(command.proacl,acldefault('f',command.proowner))) privilege
        where privilege.grantee not in(owner_id,api_id,worker_id)))
    and exists(select 1 from pg_policy policy where policy.polrelid=to_regclass('app.inbox_receipts')
      and policy.polname='inbox_receipts_connection_health_owner_select' and policy.polcmd='r'
      and policy.polroles=array[owner_id] and policy.polwithcheck is null
      and pg_get_expr(policy.polqual,policy.polrelid)='(((workspace_id)::text = NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text)) AND ((consumer_name)::text = ''connection-health-worker''::text))')
    and exists(select 1 from pg_policy policy where policy.polrelid=to_regclass('app.outbox_events')
      and policy.polname='outbox_events_connection_health_owner_delete' and policy.polcmd='d'
      and policy.polroles=array[owner_id] and policy.polwithcheck is null
      and pg_get_expr(policy.polqual,policy.polrelid)='(((workspace_id)::text = NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text)) AND ((job_name)::text = ''apply-connection-health-observation''::text))')
    and not exists(select 1 from (values('inbox_receipts_owner_leased_purge_select','r'),
      ('inbox_receipts_owner_leased_purge_delete','d')) expected(name,command)
      where not exists(select 1 from pg_policy policy where policy.polrelid=to_regclass('app.inbox_receipts')
        and policy.polname=expected.name and policy.polcmd::text=expected.command
        and policy.polroles=array[owner_id] and policy.polwithcheck is null
        and pg_get_expr(policy.polqual,policy.polrelid)='(((workspace_id)::text = NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text)) AND app.workspace_purge_immutable_delete_is_armed(workspace_id))'))
    and exists(select 1 from pg_policy policy where policy.polrelid=to_regclass('app.inbox_receipts')
      and policy.polname='inbox_receipts_owner_leased_purge_lock' and policy.polcmd='w'
      and policy.polroles=array[owner_id]
      and pg_get_expr(policy.polqual,policy.polrelid)='(((workspace_id)::text = NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text)) AND app.workspace_purge_immutable_delete_is_armed(workspace_id))'
      and pg_get_expr(policy.polwithcheck,policy.polrelid)=pg_get_expr(policy.polqual,policy.polrelid))
    and exists(select 1 from pg_policy policy where policy.polrelid=to_regclass('app.outbox_events')
      and policy.polname='outbox_events_owner_leased_purge_delete' and policy.polcmd='d'
      and policy.polroles=array[owner_id] and policy.polwithcheck is null
      and pg_get_expr(policy.polqual,policy.polrelid)='(((workspace_id)::text = NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text)) AND app.workspace_purge_immutable_delete_is_armed(workspace_id))')
    and not exists(select 1 from (values
      ('app.connections','connections_health_protocol','app.enforce_connection_health_protocol()',19),
      ('app.connection_health_observations','connection_health_observations_command_cleanup','app.cleanup_connection_health_command()',9)
    ) expected(relation,name,signature,type) where not exists(select 1 from pg_trigger trigger
      where trigger.tgrelid=to_regclass(expected.relation) and trigger.tgname=expected.name
        and trigger.tgfoid=to_regprocedure(expected.signature) and trigger.tgenabled='O' and trigger.tgtype=expected.type
        and not trigger.tgisinternal and trigger.tgqual is null and cardinality(trigger.tgattr::smallint[])=0))
    and not exists(select 1 from (values
      ('app.node_attempt_connection_dispatches','node_attempt_connection_dispatches_attempt_fk','FOREIGN KEY (workspace_id, attempt_id) REFERENCES app.node_attempts(workspace_id, id) ON DELETE CASCADE'),
      ('app.connection_health_observations','connection_health_observations_dispatch_fk','FOREIGN KEY (workspace_id, attempt_id) REFERENCES app.node_attempt_connection_dispatches(workspace_id, attempt_id) ON DELETE CASCADE'),
      ('app.node_attempt_connection_dispatches','node_attempt_connection_dispatches_pkey','PRIMARY KEY (workspace_id, attempt_id)'),
      ('app.connection_health_observations','connection_health_observations_attempt_unique','UNIQUE (workspace_id, attempt_id)'),
      ('app.connection_health_observations','connection_health_observations_outbox_event_id_key','UNIQUE (outbox_event_id)'),
      ('app.connections','connections_health_revision_positive','CHECK ((health_revision > 0))'),
      ('app.connection_events','connection_events_type_valid','CHECK (((event_type)::text = ANY ((ARRAY[''connection.created''::character varying, ''connection.secret_rotated''::character varying, ''connection.test_succeeded''::character varying, ''connection.test_failed''::character varying, ''connection.reauthorization_required''::character varying, ''connection.revoked''::character varying, ''connection.credential_accessed''::character varying, ''connection.health_changed''::character varying])::text[])))'),
      ('app.connections','connections_health_transition_source_valid','CHECK (((((last_health_transition_at IS NULL) AND (last_health_transition_source IS NULL)) OR ((last_health_transition_at IS NOT NULL) AND ((last_health_transition_source)::text = ANY ((ARRAY[''run''::character varying, ''test''::character varying, ''rotation''::character varying, ''revoke''::character varying])::text[])))) IS TRUE))'),
      ('app.node_attempt_connection_dispatches','node_attempt_connection_dispatches_provider_key_check','CHECK (((provider_key)::text = ''slack''::text))'),
      ('app.node_attempt_connection_dispatches','node_attempt_connection_dispatches_auth_type_check','CHECK (((auth_type)::text = ''slack_bot_token''::text))'),
      ('app.node_attempt_connection_dispatches','node_attempt_connection_dispatches_health_revision_check','CHECK ((health_revision > 0))'),
      ('app.node_attempt_connection_dispatches','node_attempt_connection_dispatches_fence_token_check','CHECK ((fence_token > 0))'),
      ('app.connection_health_observations','connection_health_observations_production_mode_check','CHECK (((production_mode)::text = ANY ((ARRAY[''observe''::character varying, ''enforce''::character varying])::text[])))'),
      ('app.connection_health_observations','connection_health_observations_signal_valid','CHECK (((((kind)::text = ''healthy''::text) AND (reason_code IS NULL)) OR (((kind)::text = ''reauthorization_required''::text) AND (reason_code IS NOT NULL) AND ((reason_code)::text = ANY ((ARRAY[''connection.slack_account_inactive''::character varying, ''connection.slack_token_expired''::character varying, ''connection.slack_token_revoked''::character varying])::text[])))))')
    ) expected(relation,name,definition) where not exists(select 1 from pg_constraint constraint_row
      where constraint_row.conrelid=to_regclass(expected.relation) and constraint_row.conname=expected.name
        and pg_get_constraintdef(constraint_row.oid)=expected.definition and constraint_row.convalidated))
    and exists(select 1 from pg_index index_state join pg_class relation on relation.oid=index_state.indexrelid
      where index_state.indexrelid=to_regclass('app.connection_health_observations_workspace_time_idx')
        and index_state.indrelid=to_regclass('app.connection_health_observations') and relation.relowner=owner_id
        and relation.relam=(select oid from pg_am where amname='btree') and index_state.indisvalid and index_state.indisready
        and not index_state.indisunique and index_state.indexprs is null and index_state.indpred is null
        and index_state.indnatts=3 and index_state.indnkeyatts=3
        and (select array_agg(pg_get_indexdef(index_state.indexrelid,ordinal,true) order by ordinal)
          from generate_series(1,3) ordinal)=array['workspace_id','observed_at','id']::text[])
  ,false) from boundary_roles
)`;
