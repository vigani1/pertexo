export const READINESS_TRIGGERS_MIGRATION_SQL = `
      (
        exists (
          select 1 from pg_attribute
          where attrelid = 'app.node_runs'::regclass
            and attname = 'due_wakeup_at' and not attisdropped
        )
        and exists (
          select 1 from pg_constraint
          where conrelid = 'app.node_runs'::regclass
            and conname = 'node_runs_due_wakeup_consistent'
        )
        and exists (
          select 1 from pg_proc
          where oid = to_regprocedure('app.claim_due_node_run_wakeups(integer)')
            and prosecdef
            and pg_get_userbyid(proowner) = $1
            and proconfig = array['search_path=pg_catalog, pg_temp']::text[]
        )
        and has_function_privilege($2, 'app.claim_due_node_run_wakeups(integer)', 'EXECUTE')
        and has_column_privilege($2, 'app.node_runs', 'due_wakeup_at', 'UPDATE')
        and not exists (
          select 1
          from pg_proc function_record,
               lateral aclexplode(coalesce(
                 function_record.proacl,
                 acldefault('f', function_record.proowner)
               )) privilege
          where function_record.oid =
                to_regprocedure('app.claim_due_node_run_wakeups(integer)')
            and privilege.privilege_type = 'EXECUTE'
            and privilege.grantee not in (
              (select oid from pg_roles where rolname = $1),
              (select oid from pg_roles where rolname = $2)
            )
        )
        and exists (
          select 1 from pg_policy
          where polrelid = 'app.node_runs'::regclass
            and polname = 'node_runs_due_wakeup_owner_select'
        )
        and exists (
          select 1 from pg_policy
          where polrelid = 'app.node_runs'::regclass
            and polname = 'node_runs_due_wakeup_owner_update'
        )
        and exists (
          select 1 from pg_policy
          where polrelid = 'app.outbox_events'::regclass
            and polname = 'outbox_events_due_wakeup_owner_insert'
        )
      ) as due_node_wakeups_compatible,
      (
        exists (
          select 1 from pg_attribute
          where attrelid='app.node_runs'::regclass
            and attname='wait_kind' and not attisdropped
        )
        and exists (
          select 1 from pg_attribute attribute
          join pg_attrdef default_record
            on default_record.adrelid=attribute.attrelid
           and default_record.adnum=attribute.attnum
          where attribute.attrelid='app.node_attempts'::regclass
            and attribute.attname='admission_kind'
            and attribute.attnotnull and not attribute.attisdropped
            and pg_get_expr(default_record.adbin, default_record.adrelid) =
              '''execute''::character varying'
        )
        and exists (
          select 1 from pg_attribute
          where attrelid='app.workflow_runs'::regclass
            and attname='deadline_wakeup_at' and not attisdropped
        )
        and not exists (
          select 1 from (values
            ('node_runs', 'node_runs_wait_kind_valid'),
            ('node_runs', 'node_runs_wait_state_valid'),
            ('node_attempts', 'node_attempts_admission_kind_valid'),
            ('workflow_runs', 'workflow_runs_deadline_wakeup_consistent')
          ) expected(table_name, constraint_name)
          where not exists (
            select 1 from pg_constraint
            where conrelid=to_regclass('app.' || expected.table_name)
              and conname=expected.constraint_name
          )
        )
        and exists (
          select 1 from pg_proc
          where oid=to_regprocedure('app.claim_due_workflow_run_deadlines(integer)')
            and prosecdef
            and pg_get_userbyid(proowner)=$1
            and proconfig=array['search_path=pg_catalog, pg_temp']::text[]
        )
        and has_function_privilege($2, 'app.claim_due_workflow_run_deadlines(integer)', 'EXECUTE')
        and has_column_privilege($2, 'app.node_runs', 'wait_kind', 'UPDATE')
        and has_column_privilege($2, 'app.workflow_runs', 'deadline_wakeup_at', 'UPDATE')
        and not exists (
          select 1 from pg_proc function_record,
            lateral aclexplode(coalesce(
              function_record.proacl,
              acldefault('f', function_record.proowner)
            )) privilege
          where function_record.oid=to_regprocedure('app.claim_due_workflow_run_deadlines(integer)')
            and privilege.privilege_type='EXECUTE'
            and privilege.grantee not in (
              (select oid from pg_roles where rolname=$1),
              (select oid from pg_roles where rolname=$2)
            )
        )
        and exists (
          select 1 from pg_policy
          where polrelid='app.workflow_runs'::regclass
            and polname='workflow_runs_deadline_wakeup_owner_select'
        )
        and exists (
          select 1 from pg_policy
          where polrelid='app.workflow_runs'::regclass
            and polname='workflow_runs_deadline_wakeup_owner_update'
        )
      ) as durable_wait_compatible,
      (
        to_regclass('app.run_failure_notification_intents') is not null
        and to_regclass('app.run_failure_notification_audit_facts') is not null
        and (select relrowsecurity and relforcerowsecurity
             from pg_class where oid=to_regclass('app.run_failure_notification_intents'))
        and (select relrowsecurity and relforcerowsecurity
             from pg_class where oid=to_regclass('app.run_failure_notification_audit_facts'))
        and exists (select 1 from pg_constraint
          where conrelid=to_regclass('app.run_failure_notification_intents')
            and conname='run_failure_notification_intents_logical_unique')
        and exists (select 1 from pg_constraint
          where conrelid=to_regclass('app.run_failure_notification_intents')
            and conname='run_failure_notification_intents_context_bounded')
        and exists (select 1 from pg_constraint
          where conrelid=to_regclass('app.run_failure_notification_intents')
            and conname='run_failure_notification_intents_run_pin_fk'
            and not convalidated)
        and exists (select 1 from pg_constraint
          where conrelid=to_regclass('app.run_failure_notification_intents')
            and conname='run_failure_notification_intents_status_valid'
            and pg_get_constraintdef(oid) like '%claimed%')
        and exists (select 1 from pg_trigger
          where tgrelid=to_regclass('app.run_failure_notification_intents')
            and tgname='run_failure_notification_intents_require_run_pin'
            and not tgisinternal)
        and exists (select 1 from pg_policy
          where polrelid=to_regclass('app.run_failure_notification_intents')
            and polname='run_failure_notification_intents_workspace_scope')
        and has_table_privilege($2, 'app.run_failure_notification_intents', 'SELECT')
        and has_table_privilege($2, 'app.run_failure_notification_intents', 'INSERT')
        and has_column_privilege($2, 'app.run_failure_notification_intents', 'status', 'UPDATE')
        and not has_column_privilege($2, 'app.run_failure_notification_intents', 'context', 'UPDATE')
        and not has_table_privilege($2, 'app.run_failure_notification_intents', 'DELETE')
        and has_table_privilege($2, 'app.run_failure_notification_audit_facts', 'INSERT')
        and not has_table_privilege($2, 'app.run_failure_notification_audit_facts', 'UPDATE')
        and not has_table_privilege($2, 'app.run_failure_notification_audit_facts', 'DELETE')
        and to_regclass('app.failure_notification_destinations') is not null
        and to_regclass('app.failure_notification_destination_versions') is not null
        and to_regclass('app.workflow_failure_notification_policies') is not null
        and (select relrowsecurity and relforcerowsecurity from pg_class
             where oid=to_regclass('app.failure_notification_destinations'))
        and (select relrowsecurity and relforcerowsecurity from pg_class
             where oid=to_regclass('app.failure_notification_destination_versions'))
        and (select relrowsecurity and relforcerowsecurity from pg_class
             where oid=to_regclass('app.workflow_failure_notification_policies'))
        and exists (select 1 from pg_constraint
          where conrelid=to_regclass('app.failure_notification_destination_versions')
            and conname='failure_notification_destination_versions_config_strict')
        and exists (select 1 from pg_constraint
          where conrelid=to_regclass('app.failure_notification_destination_versions')
            and conname='failure_notification_destination_versions_destination_kind_fk')
        and exists (select 1 from pg_trigger
          where tgrelid=to_regclass('app.failure_notification_destination_versions')
            and tgname='failure_notification_destination_versions_immutable'
            and not tgisinternal)
        and has_table_privilege($2, 'app.failure_notification_destinations', 'SELECT')
        and has_table_privilege($2, 'app.failure_notification_destination_versions', 'SELECT')
        and not has_table_privilege($2, 'app.failure_notification_destinations', 'INSERT')
        and not has_table_privilege($2, 'app.failure_notification_destination_versions', 'INSERT')
        and not has_table_privilege($2, 'app.workflow_failure_notification_policies', 'SELECT')
        and has_column_privilege($2, 'app.run_failure_notification_intents', 'delivery_binding', 'UPDATE')
        and not has_column_privilege($2, 'app.run_failure_notification_intents', 'connection_secret_version_id', 'UPDATE')
        and has_function_privilege($2, 'app.recover_due_run_failure_notifications(integer,integer)', 'EXECUTE')
        and to_regprocedure('app.recover_due_run_failure_notifications(integer)') is null
      ) as failure_notification_compatible,
      (
        to_regclass('app.workspace_execution_entitlement_versions') is not null
        and to_regclass('app.workspace_execution_entitlements') is not null
        and to_regclass('app.workspace_execution_admission_counters') is not null
        and to_regclass('app.workflow_run_active_admissions') is not null
        and (select relrowsecurity and relforcerowsecurity from pg_class
             where oid=to_regclass('app.workspace_execution_entitlement_versions'))
        and (select relrowsecurity and relforcerowsecurity from pg_class
             where oid=to_regclass('app.workspace_execution_entitlements'))
        and (select relrowsecurity and relforcerowsecurity from pg_class
             where oid=to_regclass('app.workspace_execution_admission_counters'))
        and (select relrowsecurity and relforcerowsecurity from pg_class
             where oid=to_regclass('app.workflow_run_active_admissions'))
        and exists (select 1 from pg_trigger
          where tgrelid=to_regclass('app.workspace_execution_entitlement_versions')
            and tgname='workspace_execution_entitlement_versions_immutable'
            and tgfoid=to_regprocedure('app.reject_execution_entitlement_version_mutation()')
            and tgenabled='O' and tgtype=27 and not tgisinternal)
        and exists (select 1 from pg_trigger
          where tgrelid=to_regclass('app.workflow_runs')
            and tgname='workflow_runs_execution_admission'
            and tgfoid=to_regprocedure('app.enforce_workflow_run_admission()')
            and tgenabled='O' and tgtype=23 and not tgisinternal)
        and exists (select 1 from pg_trigger
          where tgrelid=to_regclass('app.workflow_runs')
            and tgname='workflow_runs_refresh_execution_admission'
            and tgfoid=to_regprocedure('app.refresh_workflow_run_admission_counters()')
            and tgenabled='O' and tgtype=21 and not tgisinternal)
        and exists (select 1 from pg_trigger
          where tgrelid=to_regclass('app.workspaces')
            and tgname='workspaces_provision_execution_admission'
            and tgfoid=to_regprocedure('app.provision_workspace_execution_admission()')
            and tgenabled='O' and tgtype=5 and not tgisinternal)
        and 11=(select count(*) from pg_proc admission_function
          join pg_roles admission_owner on admission_owner.oid=admission_function.proowner
          where admission_function.oid=any(array[
            to_regprocedure('app.provision_workspace_execution_admission()'),
            to_regprocedure('app.enforce_workflow_run_admission()'),
            to_regprocedure('app.refresh_workflow_run_admission_counters()'),
            to_regprocedure('app.reconcile_workspace_execution_admission(uuid)'),
            to_regprocedure('app.workflow_run_active_capacity_available(uuid,integer,uuid)'),
            to_regprocedure('app.workflow_run_active_admission_eligible(uuid,uuid,uuid)'),
            to_regprocedure('app.reserve_workflow_run_active_admission(uuid,uuid,uuid)'),
            to_regprocedure('app.release_workflow_run_active_admission(uuid,uuid)'),
            to_regprocedure('app.release_dispatcher_workflow_run_active_admission(uuid,uuid)'),
            to_regprocedure('app.arm_dispatcher_workflow_run_active_admission(uuid,uuid)'),
            to_regprocedure('app.recover_due_workflow_run_active_admissions(integer)')
          ]) and admission_function.prosecdef
            and admission_owner.rolname=$1
            and 'row_security=on'=any(admission_function.proconfig)
            and exists (select 1 from unnest(admission_function.proconfig) setting
                         where setting like 'search_path=pg_catalog%'))
        and (
          (
            has_table_privilege(current_user,'app.workspace_execution_entitlements','SELECT')
            and has_table_privilege(current_user,'app.workspace_execution_entitlement_versions','SELECT')
            and has_table_privilege(current_user,'app.workspace_execution_admission_counters','SELECT')
            and has_function_privilege(current_user,'app.reconcile_workspace_execution_admission(uuid)','EXECUTE')
          ) or (
            has_function_privilege(current_user,'app.reserve_workflow_run_active_admission(uuid,uuid,uuid)','EXECUTE')
            and has_function_privilege(current_user,'app.workflow_run_active_admission_eligible(uuid,uuid,uuid)','EXECUTE')
            and has_function_privilege(current_user,'app.arm_dispatcher_workflow_run_active_admission(uuid,uuid)','EXECUTE')
            and has_function_privilege(current_user,'app.recover_due_workflow_run_active_admissions(integer)','EXECUTE')
          )
        )
        and not has_table_privilege(current_user,'app.workspace_execution_entitlement_versions','INSERT')
        and not has_table_privilege(current_user,'app.workspace_execution_entitlements','UPDATE')
        and has_function_privilege($2,'app.workflow_run_active_capacity_available(uuid,integer,uuid)','EXECUTE')
        and has_function_privilege($2,'app.release_workflow_run_active_admission(uuid,uuid)','EXECUTE')
      ) as execution_admission_compatible,
      (
        to_regclass('app.regional_write_admission') is not null
        and (select relowner=(select oid from pg_roles where rolname=$1)
             from pg_class where oid=to_regclass('app.regional_write_admission'))
        and 2=(select count(*) from pg_proc admission_function
          join pg_roles admission_owner on admission_owner.oid=admission_function.proowner
          where admission_function.oid=any(array[
            to_regprocedure('app.record_regional_replica_lag(character varying,character varying,bigint,integer)'),
            to_regprocedure('app.assert_regional_write_admission()')
          ]) and admission_function.prosecdef
            and admission_owner.rolname=$1
            and 'row_security=on'=any(admission_function.proconfig)
            and exists (select 1 from unnest(admission_function.proconfig) setting
                         where setting like 'search_path=pg_catalog%'))
        and has_function_privilege($3,
          'app.assert_regional_write_admission()','EXECUTE')
        and has_function_privilege($2,
          'app.assert_regional_write_admission()','EXECUTE')
        and not has_table_privilege($3,
          'app.regional_write_admission','SELECT,INSERT,UPDATE,DELETE')
        and not has_table_privilege($2,
          'app.regional_write_admission','SELECT,INSERT,UPDATE,DELETE')
      ) as regional_write_admission_compatible,
      (
        to_regclass('app.workflow_triggers') is not null
        and to_regclass('app.webhook_trigger_endpoints') is not null
        and to_regclass('app.webhook_trigger_secret_versions') is not null
        and to_regclass('app.webhook_trigger_deliveries') is not null
        and to_regclass('app.webhook_trigger_replay_records') is not null
        and to_regclass('app.webhook_endpoint_ingress_limits') is not null
        and not exists (select 1 from (values
          ('workflow_triggers'),('webhook_trigger_endpoints'),
          ('webhook_trigger_secret_versions'),('webhook_trigger_deliveries'),
          ('webhook_trigger_replay_records'),('webhook_endpoint_ingress_limits')
        ) expected(table_name) where not (select relrowsecurity and relforcerowsecurity
          from pg_class where oid=to_regclass('app.'||expected.table_name)))
        and exists (select 1 from pg_trigger
          where tgrelid=to_regclass('app.webhook_trigger_secret_versions')
            and tgname='webhook_trigger_secret_versions_immutable'
            and not tgisinternal)
        and exists (select 1 from pg_proc proc
          where proc.oid=to_regprocedure('app.resolve_public_webhook_endpoint(character)')
            and proc.prosecdef and pg_get_userbyid(proc.proowner)=$1
            and 'row_security=on'=any(proc.proconfig)
            and 'search_path=pg_catalog, app'=any(proc.proconfig))
        and exists (select 1 from pg_proc proc
          where proc.oid=to_regprocedure('app.consume_webhook_ingress_limit(character)')
            and proc.prosecdef and pg_get_userbyid(proc.proowner)=$1
            and 'row_security=on'=any(proc.proconfig)
            and exists(select 1 from unnest(proc.proconfig) setting where setting like 'search_path=pg_catalog%'))
        and case when has_function_privilege(current_user,
          'app.create_workflow_with_draft(uuid,uuid,character varying,uuid,integer,jsonb,character,character,character varying,character varying)',
          'EXECUTE') then has_function_privilege(current_user,
            'app.resolve_public_webhook_endpoint(character)','EXECUTE')
          else not has_function_privilege(current_user,
            'app.resolve_public_webhook_endpoint(character)','EXECUTE') end
        and case when has_function_privilege(current_user,
          'app.create_workflow_with_draft(uuid,uuid,character varying,uuid,integer,jsonb,character,character,character varying,character varying)',
          'EXECUTE') then has_function_privilege(current_user,
            'app.consume_webhook_ingress_limit(character)','EXECUTE')
          else not has_function_privilege(current_user,
            'app.consume_webhook_ingress_limit(character)','EXECUTE') end
        and not has_table_privilege($2,'app.webhook_trigger_endpoints','SELECT')
        and not has_table_privilege($2,'app.webhook_trigger_secret_versions','SELECT')
        and not has_table_privilege(current_user,'app.webhook_trigger_secret_versions','UPDATE')
        and not has_table_privilege(current_user,'app.webhook_trigger_secret_versions','DELETE')
        and not has_table_privilege(current_user,'app.webhook_trigger_secret_versions','SELECT')
      ) as webhook_triggers_compatible,
      (
        to_regclass('app.trigger_schedules') is not null
        and to_regclass('app.trigger_schedule_occurrences') is not null
        and (select relrowsecurity and relforcerowsecurity from pg_class
          where oid=to_regclass('app.trigger_schedules'))
        and (select relrowsecurity and relforcerowsecurity from pg_class
          where oid=to_regclass('app.trigger_schedule_occurrences'))
        and exists (select 1 from pg_indexes where schemaname='app'
          and tablename='trigger_schedules' and indexname='trigger_schedules_due_idx'
           and indexdef like '%next_fire_at, workspace_id, trigger_id%'
          and indexdef like '%status%enabled%')
        and exists (select 1 from pg_constraint where
          conrelid=to_regclass('app.trigger_schedule_occurrences')
          and conname='trigger_schedule_occurrences_identity_unique' and contype='u')
        and exists (select 1 from pg_trigger where
          tgrelid=to_regclass('app.trigger_schedules')
          and tgname='trigger_schedules_config_immutable' and not tgisinternal)
        and 6=(select count(*) from pg_proc proc where proc.oid=any(array[
          to_regprocedure('app.claim_due_trigger_schedules(character varying,integer,integer)'),
          to_regprocedure('app.schedule_claim_is_eligible(uuid,uuid)'),
          to_regprocedure('app.complete_trigger_schedule_claim(uuid,uuid,uuid,timestamp with time zone,character varying,uuid,timestamp with time zone)'),
          to_regprocedure('app.release_trigger_schedule_claim(uuid,uuid)'),
          to_regprocedure('app.defer_trigger_schedule_claim(uuid,uuid,integer)'),
          to_regprocedure('app.fail_trigger_schedule_claim(uuid,uuid)')
        ]) and proc.prosecdef and pg_get_userbyid(proc.proowner)=$1
          and 'row_security=on'=any(proc.proconfig)
          and exists(select 1 from unnest(proc.proconfig) setting where setting like 'search_path=pg_catalog%'))
        and has_function_privilege($2,
          'app.claim_due_trigger_schedules(character varying,integer,integer)','EXECUTE')
        and has_function_privilege($2,'app.schedule_claim_is_eligible(uuid,uuid)','EXECUTE')
        and has_function_privilege($2,
          'app.complete_trigger_schedule_claim(uuid,uuid,uuid,timestamp with time zone,character varying,uuid,timestamp with time zone)','EXECUTE')
        and has_function_privilege($2,'app.release_trigger_schedule_claim(uuid,uuid)','EXECUTE')
        and has_function_privilege($2,'app.defer_trigger_schedule_claim(uuid,uuid,integer)','EXECUTE')
        and has_function_privilege($2,'app.fail_trigger_schedule_claim(uuid,uuid)','EXECUTE')
        and has_table_privilege($2,'app.trigger_schedules','SELECT')
        and has_table_privilege($2,'app.workflow_triggers','SELECT')
        and has_column_privilege($2,'app.workflows','published_version_id','SELECT')
        and has_column_privilege($2,'app.workflows','activation_status','UPDATE')
        and has_column_privilege($2,'app.workflow_triggers','status','UPDATE')
        and has_column_privilege($2,'app.webhook_trigger_endpoints','status','SELECT')
        and has_column_privilege($2,'app.webhook_trigger_endpoints','status','UPDATE')
        and has_table_privilege($2,'app.trigger_schedules','INSERT')
        and has_column_privilege($2,'app.trigger_schedules','admission_deferred_until','UPDATE')
        and not has_column_privilege($2,'app.webhook_trigger_endpoints','endpoint_key_hash','SELECT')
        and exists(select 1 from pg_policy policy where
          policy.polrelid=to_regclass('app.workflow_triggers')
          and policy.polname='workflow_triggers_worker_reconciliation'
          and (select oid from pg_roles where rolname=$2)=any(policy.polroles))
        and exists(select 1 from pg_policy policy where
          policy.polrelid=to_regclass('app.trigger_schedules')
          and policy.polname='trigger_schedules_worker_reconciliation'
          and (select oid from pg_roles where rolname=$2)=any(policy.polroles))
        and not has_table_privilege($2,'app.trigger_schedule_occurrences','SELECT')
      ) as schedule_triggers_compatible,
      (
        select name
        from pertexo_internal.schema_migrations
        order by name desc
        limit 1
      ) as migration_head
    from pg_roles role
    join pg_class table_class on table_class.oid = 'app.rls_probe_records'::regclass
    where role.rolname = current_user
`;
