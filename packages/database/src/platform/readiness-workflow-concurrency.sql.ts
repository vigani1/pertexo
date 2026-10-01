// Shared by API/worker admission readiness and dispatcher startup. Runtime role
// identities come from the existing tenant policies, including custom role names.
export const READINESS_WORKFLOW_CONCURRENCY_SQL = `(
  with boundary_roles as (
    select (select oid from pg_roles where rolname=$1) as owner_id,
      (select runtime_role from pg_policy policy,unnest(policy.polroles) runtime_role
        where policy.polrelid=to_regclass('app.workflows') and policy.polname='workflows_workspace_scope'
          and runtime_role<>(select oid from pg_roles where rolname=$1)) as api_id,
      (select runtime_role from pg_policy policy,unnest(policy.polroles) runtime_role
        where policy.polrelid=to_regclass('app.workflows') and policy.polname='workflows_worker_trigger_reconciliation') as worker_id,
      (select runtime_role from pg_policy policy,unnest(policy.polroles) runtime_role
        where policy.polrelid=to_regclass('app.outbox_events') and policy.polname='outbox_events_dispatcher_select') as dispatcher_id
  ) select coalesce(
    owner_id is not null and api_id is not null and worker_id is not null and dispatcher_id is not null
    and not exists (
      select 1 from (values
        ('app.enforce_workflow_run_admission()','e4137b01595acc041826eb374aa5188a','owner','v',false),
        ('app.workflow_concurrency_admissible(uuid,uuid,boolean)','3c541c79eb4d3849b58d8c76a2c5fade','owner','v',true),
        ('app.workflow_concurrency_control(uuid,uuid,uuid,text,jsonb,text,text,text,text)','f37e4d9d93e59b518d37713078575eda','api','v',true),
        ('app.workflow_run_admission_blockers(uuid,uuid)','f0127382f587223639b4bfb02f120ee8','api','s',true),
        ('app.workflow_run_active_capacity_available(uuid,integer,uuid)','66e1c3ed4d6d458c4889799733c11063','worker','v',false),
        ('app.workflow_run_active_admission_eligible(uuid,uuid,uuid)','9aa4c431740581a37d4873d0e49cc567','dispatcher','v',false),
        ('app.reserve_workflow_run_active_admission(uuid,uuid,uuid)','e11cf9af2c42e62f995138c7483fe162','dispatcher','v',false)
      ) expected(signature,hash,target,volatility,temp_schema)
      where not exists(select 1 from pg_proc command
        where command.oid=to_regprocedure(expected.signature) and command.proowner=owner_id
          and command.prosecdef and command.provolatile::text=expected.volatility
          and md5(command.prosrc)=expected.hash
          and command.proconfig=array[case when expected.temp_schema then 'search_path=pg_catalog, app, pg_temp'
            else 'search_path=pg_catalog, app' end,'row_security=on']::text[]
          and has_function_privilege(case expected.target when 'api' then api_id when 'worker' then worker_id
            when 'dispatcher' then dispatcher_id else owner_id end,command.oid,'EXECUTE')
          and not exists(select 1 from aclexplode(coalesce(command.proacl,acldefault('f',command.proowner))) privilege
            where privilege.grantee not in (owner_id,case expected.target when 'api' then api_id when 'worker' then worker_id
              when 'dispatcher' then dispatcher_id else owner_id end))))
    and not exists (
      select 1 from (values('workflow_concurrency_policies'),('workflow_concurrency_command_receipts')) expected(name)
      where not exists(select 1 from pg_class relation where relation.oid=to_regclass('app.'||expected.name)
        and relation.relowner=owner_id and relation.relrowsecurity and relation.relforcerowsecurity
        and (select count(*)=1 from pg_policy where polrelid=relation.oid)
        and exists(select 1 from pg_policy policy where policy.polrelid=relation.oid and policy.polcmd='*'
          and policy.polroles=array[owner_id] and pg_get_expr(policy.polqual,policy.polrelid)='true'
          and pg_get_expr(policy.polwithcheck,policy.polrelid)='true')
        and not exists(select 1 from aclexplode(coalesce(relation.relacl,acldefault('r',relation.relowner))) privilege
          where privilege.grantee<>owner_id)))
    and exists(select 1 from pg_attribute where attrelid=to_regclass('app.workflow_runs')
      and attname='admission_ticket' and attnotnull and atttypid='bigint'::regtype and not attisdropped)
    and exists(select 1 from pg_attribute where attrelid=to_regclass('app.workflow_run_active_admissions')
      and attname='workflow_concurrency_order_exempt' and attnotnull and atttypid='boolean'::regtype and not attisdropped)
    and not has_column_privilege(api_id,'app.workflow_runs','admission_ticket','UPDATE')
    and not has_column_privilege(worker_id,'app.workflow_runs','admission_ticket','UPDATE')
    and exists(select 1 from pg_class sequence where sequence.oid=to_regclass('app.workflow_run_admission_ticket_seq')
      and sequence.relkind='S' and sequence.relowner=owner_id
      and not exists(select 1 from aclexplode(coalesce(sequence.relacl,acldefault('S',sequence.relowner))) privilege
        where privilege.grantee<>owner_id))
    and not exists (
      select 1 from (values
        ('workflow_runs_queued_admission_order_idx',array['workspace_id','workflow_id','admission_ticket','id']::text[],'756d8cb55813ae4f7e8f6f9d876c357b'),
        ('workflow_runs_workflow_active_idx',array['workspace_id','workflow_id','id']::text[],'8c893be2ec526f4919a2636624389b6c')
      ) expected(name,keys,predicate_hash) where not exists(
        select 1 from pg_index index_state join pg_class relation on relation.oid=index_state.indexrelid
        where index_state.indexrelid=to_regclass('app.'||expected.name) and index_state.indrelid=to_regclass('app.workflow_runs')
          and relation.relam=(select oid from pg_am where amname='btree') and index_state.indisvalid and index_state.indisready
          and relation.relowner=owner_id and index_state.indexprs is null
          and index_state.indnatts=cardinality(expected.keys) and index_state.indnkeyatts=cardinality(expected.keys)
          and (select array_agg(pg_get_indexdef(index_state.indexrelid,ordinal,true) order by ordinal)
            from generate_series(1,index_state.indnatts) ordinal)=expected.keys
          and md5(pg_get_expr(index_state.indpred,index_state.indrelid))=expected.predicate_hash))
  ,false) from boundary_roles
)`;
