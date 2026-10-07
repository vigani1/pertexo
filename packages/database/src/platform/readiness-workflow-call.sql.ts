// ADR065 Phase 1: exact registered inline-JSON Call catalog. The independent
// writer flag is not a readiness value: OFF must continue draining accepted work.
const WORKFLOW_CALL_CATALOG_SQL = `
with configured_roles as (select $1::text owner_role,$2::text worker_role,$3::text api_role,
  $4::text maintenance_role,$5::text operator_role), relations as (
  select c.* from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='app' and c.relname=any(array[
    'workflow_calls','workflow_execution_value_provenance','workflow_call_rollout'])
), inventory as (
  select c.relname,jsonb_build_object(
    'name',c.relname,'kind',c.relkind,'rls',c.relrowsecurity,'forced',c.relforcerowsecurity,
    'partition',c.relispartition,
    'columns',(select jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),
      a.attnotnull,a.attidentity,a.attgenerated,co.collname,pg_get_expr(d.adbin,d.adrelid)) order by a.attnum)
      from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
      left join pg_collation co on co.oid=a.attcollation
      where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
    'constraints',(select jsonb_agg(jsonb_build_array(k.conname,k.contype,k.convalidated,
      k.condeferrable,k.condeferred,pg_get_constraintdef(k.oid)) order by k.conname collate "C")
      from pg_constraint k where k.conrelid=c.oid),
    'indexes',(select jsonb_agg(jsonb_build_array(pg_get_indexdef(i.indexrelid),i.indisvalid,
      i.indisready,i.indislive,i.indisunique,i.indisprimary,i.indisexclusion)
      order by pg_get_indexdef(i.indexrelid) collate "C") from pg_index i where i.indrelid=c.oid),
    'policies',(select jsonb_agg(jsonb_build_array(p.polname,p.polcmd,p.polpermissive,
      (select jsonb_agg(case when r.rolname=$1 then 'owner' when r.rolname=$5 then 'operator'
        else coalesce(r.rolname,'PUBLIC') end order by r.rolname collate "C")
        from unnest(p.polroles) role_id left join pg_roles r on r.oid=role_id),
      pg_get_expr(p.polqual,p.polrelid),pg_get_expr(p.polwithcheck,p.polrelid)) order by p.polname collate "C")
      from pg_policy p where p.polrelid=c.oid),
    'triggers',(select jsonb_agg(pg_get_triggerdef(t.oid)||':'||t.tgenabled::text order by t.tgname collate "C")
      from pg_trigger t where t.tgrelid=c.oid and not t.tgisinternal)
  ) body from relations c
)
select encode(sha256(convert_to(jsonb_build_object(
  'relations',coalesce(jsonb_agg(body order by relname collate "C"),'[]'::jsonb),
  'functions',(select jsonb_agg(jsonb_build_array(signature,l.lanname,p.prokind,
    p.proisstrict,p.proleakproof,p.proparallel,p.prosupport::text,
    pg_get_function_result(p.oid),pg_get_function_identity_arguments(p.oid),
    pg_get_function_arguments(p.oid)) order by signature collate "C")
    from unnest(array[
      'app.apply_workflow_call_control(uuid,jsonb)',
      'app.propagate_workflow_call_control(uuid,integer,uuid,text,jsonb)',
      'app.assert_native_advance_delivery(uuid,uuid,text)',
      'app.assert_native_callable_value(jsonb,jsonb)',
      'app.assert_native_call_detail_live(uuid)',
      'app.assert_native_inline_execution_value_bytes(jsonb,text,integer,text)',
      'app.assert_workflow_call_result_output(uuid,text,uuid,boolean)',
      'app.assert_workflow_calls_enabled()',
      'app.capture_native_run_initiation()',
      'app.check_native_call_completion_clock()',
      'app.check_native_child_acceptance_commit()',
      'app.check_native_execution_value_commit_obligations()',
      'app.check_native_node_logical_projection()',
      'app.check_native_terminal_result_commit()',
      'app.executable_has_workflow_call(jsonb)',
      'app.guard_native_call_node_input()',
      'app.guard_native_execution_value_mutation()',
      'app.guard_native_run_result_projection()',
      'app.guard_workflow_call_publication()',
      'app.inspect_native_coordinator_value_owner(jsonb)',
      'app.load_native_coordinator_control_sources(jsonb,integer)',
      'app.load_native_coordinator_value_sources(jsonb,jsonb)',
      'app.lock_native_attempt_value_owner(jsonb)',
      'app.lock_native_call_input_owner(jsonb)',
      'app.lock_native_coordinator_control_sources(jsonb,integer,jsonb)',
      'app.lock_workflow_call_admission(uuid,integer,text,uuid,uuid,text)',
      'app.native_attempt_value_owner(jsonb)',
      'app.native_call_admission_scope(uuid,integer,text,uuid,text)',
      'app.native_call_lineage(uuid)',
      'app.native_coordinator_control_inventory(jsonb,integer)',
      'app.native_coordinator_value_inventory(jsonb,jsonb)',
      'app.native_execution_value_binary64_leaf(text)',
      'app.native_node_accepted_output(uuid,uuid,uuid,character varying,uuid,jsonb)',
      'app.native_workflow_call_result_provenance(uuid,text,uuid)',
      'app.prelock_native_attempt_value_owner(jsonb)',
      'app.prelock_native_coordinator_lineage(uuid,uuid,text)',
      'app.prelock_workflow_call_parent(uuid,integer,jsonb,uuid,text)',
      'app.read_native_attempt_value_source(jsonb,jsonb)',
      'app.read_native_coordinator_control_source(jsonb,jsonb)',
      'app.read_native_coordinator_value_source(jsonb,jsonb)',
      'app.read_workflow_call_declaration_input(jsonb)',
      'app.read_workflow_call_declaration_materials(uuid,text[],jsonb)',
      'app.read_workflow_call_facts(uuid)',
      'app.read_workflow_call_result_reference(uuid,text,uuid,jsonb)',
      'app.read_workflow_call_run_family(uuid)',
      'app.record_native_root_execution_input(uuid,uuid,text)',
      'app.record_native_workflow_attempt_output(jsonb,jsonb,text,integer,text)',
      'app.record_workflow_call_declaration_input(jsonb,jsonb,text,integer,text)',
      'app.record_workflow_call_outcome(uuid,integer,text,jsonb,uuid,text)',
      'app.record_workflow_call_run_result(uuid,integer,jsonb,jsonb,text,integer,text,jsonb,text)',
      'app.reserve_workflow_call_active_admission(uuid,integer,text,uuid,uuid,uuid,text)',
      'app.seal_workflow_call_parent(uuid,integer,uuid,uuid,text)',
      'app.set_workflow_calls_enabled(boolean)',
      'app.wake_native_call_parent_on_terminal()',
      'app.workflow_call_declaration_completion_reference(jsonb)',
      'app.workflow_call_family_members(uuid)',
      'app.workflow_concurrency_admissible(uuid,uuid,boolean)',
      'app.workflow_concurrency_candidate_admissible(uuid,uuid,uuid,boolean)',
      'app.workflow_run_active_admission_eligible(uuid,uuid,uuid)',
      'app.workflow_run_new_active_admission_eligible(uuid,uuid,uuid,integer)'
    ]) signature join pg_proc p on p.oid=to_regprocedure(signature)
    join pg_language l on l.oid=p.prolang)
  )::text,'UTF8')),'hex')
from inventory
`;

export const READINESS_WORKFLOW_CALL_SQL = `(
  with roles(label,id) as (
    select 'owner',oid from pg_roles where rolname=$1 union all
    select 'worker',oid from pg_roles where rolname=$2 union all
    select 'api',oid from pg_roles where rolname=$3 union all
    select 'operator',oid from pg_roles where rolname=$5 union all
    select 'dispatcher',runtime_role from pg_policy p,unnest(p.polroles) runtime_role
      where p.polrelid=to_regclass('app.outbox_events') and p.polname='outbox_events_dispatcher_select'
  ) select coalesce(
    (${WORKFLOW_CALL_CATALOG_SQL})='f6e3b94dbc46059b931ae93defcfc003434e9db247450b6b2f1481d1a2ff5d1a'
    and (select count(*)=3 from pg_class c where c.oid=any(array[
      to_regclass('app.workflow_calls'),to_regclass('app.workflow_execution_value_provenance'),to_regclass('app.workflow_call_rollout')])
      and c.relowner=(select id from roles where label='owner')
      and c.relrowsecurity and c.relforcerowsecurity
      and not exists(select 1 from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
        where a.grantee<>c.relowner and (c.relname<>'workflow_call_rollout'
          or a.grantee<>(select id from roles where label='operator')
          or a.privilege_type<>'SELECT' or a.is_grantable))
      and has_table_privilege($5,c.oid,'SELECT')=(c.relname='workflow_call_rollout')
      and not exists(select 1 from pg_attribute col,lateral aclexplode(col.attacl) a
        where col.attrelid=c.oid and a.grantee<>c.relowner))
    and not exists(select 1 from (values
    ('app.apply_workflow_call_control(uuid,jsonb)','03388ccb0f5bf29b59d5122a6ec0712a',true,'v',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['owner','worker']),
    ('app.propagate_workflow_call_control(uuid,integer,uuid,text,jsonb)','6034670c2e0c760d279ccffa7d04c731',true,'v',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['owner','worker']),
    ('app.assert_native_advance_delivery(uuid,uuid,text)','9efbc0147b28f67e222c1d2940571ff8',false,'v',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['owner']),
    ('app.assert_native_callable_value(jsonb,jsonb)','48cdbfe0f13ebe9e53c369ae8572463c',false,'v',array['search_path=pg_catalog, app, pg_temp'],array['owner']),
    ('app.assert_native_call_detail_live(uuid)','a62ef936e998537c4249181b1e6609de',false,'v',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['owner']),
    ('app.assert_native_inline_execution_value_bytes(jsonb,text,integer,text)','f919e300ebcbd460ad53d14fa16c0d77',false,'v',array['search_path=pg_catalog, app, pg_temp'],array['owner']),
    ('app.assert_workflow_call_result_output(uuid,text,uuid,boolean)','1790cef7c5270f5e332fbda89325ebda',true,'v',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['owner','worker']),
    ('app.assert_workflow_calls_enabled()','75306f56afcf009e038ac3091b347da7',true,'v',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['api','owner']),
    ('app.capture_native_run_initiation()','c5b84b003a7ae8b6e8001d7e20bf243c',true,'v',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['owner']),
    ('app.check_native_call_completion_clock()','ac4694b410cce0ca4d2d703976e005ba',true,'v',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['owner']),
    ('app.check_native_child_acceptance_commit()','5856ffbfb86a83064cde999bd5784dc1',true,'v',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['owner']),
    ('app.check_native_execution_value_commit_obligations()','8c0363116cb44864646c993a27c65a47',true,'v',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['owner']),
    ('app.check_native_node_logical_projection()','92611bd82366a64e43c4551f7f666a82',true,'v',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['owner']),
    ('app.check_native_terminal_result_commit()','b95510f7223ab22cb50efa10f2357f29',true,'v',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['owner']),
    ('app.executable_has_workflow_call(jsonb)','f1ba367f3002b0c4738225c40203b35c',false,'i',array['search_path=pg_catalog, app, pg_temp'],array['owner']),
    ('app.guard_native_call_node_input()','f84eb05dbb5e569f09a1acfa69a38386',true,'v',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['owner']),
    ('app.guard_native_execution_value_mutation()','e9f958d70d35e319dcc5a2b282950790',true,'v',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['owner']),
    ('app.guard_native_run_result_projection()','364e2763b80c2042050bd1733f4ff060',true,'v',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['owner']),
    ('app.guard_workflow_call_publication()','5f728af90fe98b4a301dd6155d2d595f',true,'v',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['owner']),
    ('app.inspect_native_coordinator_value_owner(jsonb)','0dcdf90505527bbfe6ed1596a530bf2b',true,'v',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['owner','worker']),
    ('app.load_native_coordinator_control_sources(jsonb,integer)','e8778ceb31ea7615bf8c4ce5a8f406ac',true,'v',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['owner','worker']),
    ('app.load_native_coordinator_value_sources(jsonb,jsonb)','b512a2890b44c468ea2faaf9cce354b1',true,'v',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['owner','worker']),
    ('app.lock_native_attempt_value_owner(jsonb)','54fe1b15d99d5d3dd86bd5e955223ea3',false,'v',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['owner']),
    ('app.lock_native_call_input_owner(jsonb)','c90186db5fe6ee66f91f10c4cd91910b',false,'v',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['owner']),
    ('app.lock_native_coordinator_control_sources(jsonb,integer,jsonb)','a655639891559cd5ea049767c014b98b',true,'v',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['owner','worker']),
    ('app.lock_workflow_call_admission(uuid,integer,text,uuid,uuid,text)','23aed012eaea5daafa7f904501e87d9c',true,'v',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['owner','worker']),
    ('app.native_attempt_value_owner(jsonb)','4d29c9ee3798c0b36d0ba0576cfd463b',false,'v',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['owner']),
    ('app.native_call_admission_scope(uuid,integer,text,uuid,text)','01e99d5fb976410091b4337a70fa5b77',false,'v',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['owner']),
    ('app.native_call_lineage(uuid)','95d96ecc9b212d70b867161ed94fc8d7',false,'v',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['owner']),
    ('app.native_coordinator_control_inventory(jsonb,integer)','0c1eef8ede41bdbb2f1d6c71c39a20da',false,'v',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['owner']),
    ('app.native_coordinator_value_inventory(jsonb,jsonb)','199270edc2c8e58890ad96e7a17815b3',false,'v',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['owner']),
    ('app.native_execution_value_binary64_leaf(text)','2cd979c5128a671477f648e442ca3b86',false,'i',array['search_path=pg_catalog, app, pg_temp'],array['owner']),
    ('app.native_node_accepted_output(uuid,uuid,uuid,character varying,uuid,jsonb)','34ce86d2c799e180c729b5fadc509510',true,'s',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['owner']),
    ('app.native_workflow_call_result_provenance(uuid,text,uuid)','f21999685f76372ab902e81af8848bb9',false,'v',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['owner']),
    ('app.prelock_native_attempt_value_owner(jsonb)','02a38128cf73b8465e0dedaef96984d9',true,'v',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['owner','worker']),
    ('app.prelock_native_coordinator_lineage(uuid,uuid,text)','c9a01dba54e786a04df2ede10d701377',true,'v',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['owner','worker']),
    ('app.prelock_workflow_call_parent(uuid,integer,jsonb,uuid,text)','9664ce573ba4ebddfe2ae5e6486b3709',true,'v',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['owner','worker']),
    ('app.read_native_attempt_value_source(jsonb,jsonb)','51a977b1cafe6e98a9c39657c831d6dc',true,'v',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['owner','worker']),
    ('app.read_native_coordinator_control_source(jsonb,jsonb)','b512445476069dceaf3c1a5c02759874',true,'v',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['owner','worker']),
    ('app.read_native_coordinator_value_source(jsonb,jsonb)','872be94f718f4d814f74d0d1f89c4f81',true,'v',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['owner','worker']),
    ('app.read_workflow_call_declaration_input(jsonb)','48296879e2534b9a4da36f790e1e1c34',true,'v',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['owner','worker']),
    ('app.read_workflow_call_declaration_materials(uuid,text[],jsonb)','ad11812167b775405c700608ea3bd675',true,'v',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['owner','worker']),
    ('app.read_workflow_call_facts(uuid)','9a7f7d39a95e30d4859e6678b1132ff8',true,'v',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['owner','worker']),
    ('app.read_workflow_call_result_reference(uuid,text,uuid,jsonb)','db298db72297b8eba93fd55d3b83407b',true,'v',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['owner','worker']),
    ('app.read_workflow_call_run_family(uuid)','f85d259038e00a83fe6f192136d7cf9b',true,'v',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['api','owner']),
    ('app.record_native_root_execution_input(uuid,uuid,text)','80cc4eef491fb676fdf0a063686dcabd',true,'v',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['api','owner','worker']),
    ('app.record_native_workflow_attempt_output(jsonb,jsonb,text,integer,text)','e10b144e7aeace7e50ed3827e515a22e',true,'v',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['owner','worker']),
    ('app.record_workflow_call_declaration_input(jsonb,jsonb,text,integer,text)','3dce54c2af3b0beed996e2b7f051c143',true,'v',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['owner','worker']),
    ('app.record_workflow_call_outcome(uuid,integer,text,jsonb,uuid,text)','f0f82c04efc804896dd7a12bd2785613',true,'v',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['owner','worker']),
    ('app.record_workflow_call_run_result(uuid,integer,jsonb,jsonb,text,integer,text,jsonb,text)','6e3218edc7b50c6675eda418a46d36d9',true,'v',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['owner','worker']),
    ('app.reserve_workflow_call_active_admission(uuid,integer,text,uuid,uuid,uuid,text)','fdeabd13ed2decb91fba12b307a029b2',true,'v',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['owner','worker']),
    ('app.seal_workflow_call_parent(uuid,integer,uuid,uuid,text)','a97375074000509551b9fe8da3332905',true,'v',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['owner','worker']),
    ('app.set_workflow_calls_enabled(boolean)','75d4b23ef297ea6e294c70ed42d431bb',true,'v',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['operator','owner']),
    ('app.wake_native_call_parent_on_terminal()','ec6d808f2698baf084106feadb085346',true,'v',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['owner']),
    ('app.workflow_call_declaration_completion_reference(jsonb)','8da75b354b233cc1fdc937ca4722f84b',true,'v',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['owner','worker']),
    ('app.workflow_call_family_members(uuid)','aee5b0504b453e56c7d6a911366537c8',false,'v',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['owner']),
    ('app.workflow_concurrency_admissible(uuid,uuid,boolean)','4f2b5fe534190e0d4af122280a636775',true,'v',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['owner']),
    ('app.workflow_concurrency_candidate_admissible(uuid,uuid,uuid,boolean)','e274cc6d78199156c1fda38fe6d70609',true,'v',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['owner']),
    ('app.workflow_run_active_admission_eligible(uuid,uuid,uuid)','02b0d390926624f0ea6d41ffe8ed92a5',true,'v',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['dispatcher','owner']),
    ('app.workflow_run_new_active_admission_eligible(uuid,uuid,uuid,integer)','0984d1fbc2e722b09b9fc4fa4a6a50e0',true,'v',array['search_path=pg_catalog, app, pg_temp','row_security=on'],array['owner'])
    ) expected(signature,hash,definer,volatility,configuration,execution_roles)
      where not exists(select 1 from pg_proc p where p.oid=to_regprocedure(expected.signature)
        and p.proowner=(select id from roles where label='owner')
        and md5(p.prosrc)=expected.hash and p.prosecdef=expected.definer
        and p.provolatile::text=expected.volatility and p.proconfig=expected.configuration
        and (select array_agg(r.label order by r.label collate "C")
          from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
          left join roles r on r.id=a.grantee where a.privilege_type='EXECUTE')=expected.execution_roles
        and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
          where a.is_grantable or not exists(select 1 from roles r where r.id=a.grantee))))
    and not exists(select 1 from (values
    ('app.workflow_runs','aa_native_run_initiation','app.capture_native_run_initiation()',23,false,false),
    ('app.node_attempts','native_call_completion_clock','app.check_native_call_completion_clock()',17,true,true),
    ('app.workflow_calls','native_call_final_seal_required','app.check_native_execution_value_commit_obligations()',21,true,true),
    ('app.node_runs','native_call_node_input_immutable','app.guard_native_call_node_input()',19,false,false),
    ('app.workflow_calls','native_call_outcome_immutable','app.guard_native_execution_value_mutation()',19,false,false),
    ('app.workflow_runs','native_child_acceptance_complete','app.check_native_child_acceptance_commit()',5,true,true),
    ('app.workflow_runs','native_child_terminal_parent_wakeup','app.wake_native_call_parent_on_terminal()',17,false,false),
    ('app.node_runs','native_node_logical_projection_owned','app.check_native_node_logical_projection()',17,true,true),
    ('app.workflow_runs','native_run_result_projection_immutable','app.guard_native_run_result_projection()',19,false,false),
    ('app.workflow_runs','native_terminal_result_complete','app.check_native_terminal_result_commit()',17,true,true),
    ('app.workflow_execution_value_provenance','native_value_provenance_immutable','app.guard_native_execution_value_mutation()',19,false,false),
    ('app.workflow_versions','workflow_call_publication_writer_fence','app.guard_workflow_call_publication()',7,false,false)
    ) expected(relation,name,signature,type,can_defer,initially_deferred)
      where not exists(select 1 from pg_trigger t where t.tgrelid=to_regclass(expected.relation)
        and t.tgname=expected.name and t.tgfoid=to_regprocedure(expected.signature)
        and t.tgtype=expected.type and t.tgdeferrable=expected.can_defer
        and t.tginitdeferred=expected.initially_deferred and t.tgenabled='O' and not t.tgisinternal))
    and not exists(select 1 from (values
    ('app.node_runs','node_runs_native_value_scope_unique','577aa8d758d8a9dc799adcd26bad7dba'),
    ('app.node_attempts','node_attempts_native_value_scope_unique','a0448ea214e99c04b953321907383d36'),
    ('app.workflow_runs','native_run_initiation_pair','9d1ea3404bb96d1c801ef0e5f4468d3a'),
    ('app.workflow_versions','workflow_versions_schema_version_supported','0377cc296273d86d38d35f52104605e0')
    ) expected(relation,name,hash)
      where not exists(select 1 from pg_constraint c where c.conrelid=to_regclass(expected.relation)
        and c.conname=expected.name and c.convalidated and md5(pg_get_constraintdef(c.oid))=expected.hash))
    and exists(select 1 from pg_proc p join pg_language l on l.oid=p.prolang
      where p.oid=to_regprocedure('app.propagate_workflow_call_control(uuid,integer,uuid,text,jsonb)')
        and l.lanname='plpgsql' and p.prokind='f' and not p.proisstrict
        and not p.proleakproof and p.proparallel='u' and p.prosupport=0
        and pg_get_function_result(p.oid)='jsonb'
        and pg_get_function_arguments(p.oid)='p_parent uuid, p_revision integer, p_child uuid, p_reason text, p_delivery jsonb')
  ,false)
)`;
