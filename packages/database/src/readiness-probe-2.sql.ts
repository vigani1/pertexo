export const READINESS_EXECUTION_SQL = `
      (
        exists (
          select 1 from pg_constraint
          where conrelid = to_regclass('app.workflow_versions')
            and conname = 'workflow_versions_checksum_format'
            and pg_get_constraintdef(oid) = 'CHECK ((((((checksum)::text ~ ''^wf:v1:sha256:[0-9a-f]{64}$''::text) AND (executable_schema_version IS NULL) AND (executable_json IS NULL) AND (compatibility_release_epoch IS NULL)) OR (((checksum)::text ~ ''^wf:v2:sha256:[0-9a-f]{64}$''::text) AND (executable_schema_version IS NOT NULL) AND (executable_schema_version = 2) AND (executable_json IS NOT NULL) AND (jsonb_typeof(executable_json) = ''object''::text) AND (compatibility_release_epoch IS NOT NULL) AND (compatibility_release_epoch > 0))) IS TRUE))'
        )
        and exists (
          select 1 from pg_constraint
          where conrelid = to_regclass('app.workflow_versions')
            and conname = 'workflow_versions_executable_bounded'
            and pg_get_constraintdef(oid) = 'CHECK (((executable_json IS NULL) OR (octet_length((executable_json)::text) <= 1048576)))'
        )
      ) as phase3_schema_compatible,
      exists (
        select 1 from pg_policy policy
        where policy.polrelid = to_regclass('app.workflow_versions')
          and policy.polname = 'workflow_versions_worker_execution_read'
          and policy.polcmd = 'r'
          and cardinality(policy.polroles) = 1
          and policy.polroles[1] = (select oid from pg_roles where rolname = $2)
          and pg_get_expr(policy.polqual, policy.polrelid) = '(((workspace_id)::text = NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text)) AND ((checksum)::text ~~ ''wf:v2:sha256:%''::text) AND (executable_schema_version = 2) AND (executable_json IS NOT NULL) AND (compatibility_release_epoch > 0))'
          and policy.polwithcheck is null
      ) as phase3_policy_compatible,
      (
        select
          not worker_role.rolsuper
          and not worker_role.rolbypassrls
          and not pg_has_role(worker_role.rolname, $1::name, 'MEMBER')
          and pg_get_userbyid((select relowner from pg_class where oid = to_regclass('app.workflow_versions'))) <> worker_role.rolname
          and has_column_privilege(worker_role.rolname, 'app.workflow_versions', 'id', 'SELECT')
          and has_column_privilege(worker_role.rolname, 'app.workflow_versions', 'workspace_id', 'SELECT')
          and has_column_privilege(worker_role.rolname, 'app.workflow_versions', 'workflow_id', 'SELECT')
          and has_column_privilege(worker_role.rolname, 'app.workflow_versions', 'version_number', 'SELECT')
          and has_column_privilege(worker_role.rolname, 'app.workflow_versions', 'schema_version', 'SELECT')
          and has_column_privilege(worker_role.rolname, 'app.workflow_versions', 'checksum', 'SELECT')
          and has_column_privilege(worker_role.rolname, 'app.workflow_versions', 'executable_schema_version', 'SELECT')
          and has_column_privilege(worker_role.rolname, 'app.workflow_versions', 'executable_json', 'SELECT')
          and has_column_privilege(worker_role.rolname, 'app.workflow_versions', 'compatibility_release_epoch', 'SELECT')
          and not has_column_privilege(worker_role.rolname, 'app.workflow_versions', 'graph_json', 'SELECT')
          and not has_column_privilege(worker_role.rolname, 'app.workflow_versions', 'published_by', 'SELECT')
          and not has_column_privilege(worker_role.rolname, 'app.workflow_versions', 'published_at', 'SELECT')
          and not has_table_privilege(worker_role.rolname, 'app.workflow_versions', 'SELECT')
          and not has_table_privilege(worker_role.rolname, 'app.workflow_versions', 'INSERT')
          and not has_table_privilege(worker_role.rolname, 'app.workflow_versions', 'UPDATE')
          and not has_table_privilege(worker_role.rolname, 'app.workflow_versions', 'DELETE')
          and not has_table_privilege(worker_role.rolname, 'app.workflow_versions', 'TRUNCATE')
          and not has_table_privilege(worker_role.rolname, 'app.workflow_versions', 'REFERENCES')
          and not has_table_privilege(worker_role.rolname, 'app.workflow_versions', 'TRIGGER')
          and not has_table_privilege(worker_role.rolname, 'app.workflows', 'SELECT')
          and not has_table_privilege(worker_role.rolname, 'app.workflow_drafts', 'SELECT')
        from pg_roles worker_role
        where worker_role.rolname = $2
      ) as phase3_grants_compatible,
      (
        exists (
          select 1 from pg_attribute
          where attrelid = to_regclass('app.workflow_runs')
            and attname = 'input_ref' and atttypid = 'jsonb'::regtype
            and not attnotnull and not attisdropped
        )
        and exists (
          select 1 from pg_attribute
          where attrelid = to_regclass('app.workflow_runs')
            and attname = 'input_ref_expires_at'
            and atttypid = 'timestamp with time zone'::regtype
            and not attnotnull and not attisdropped
        )
        and (select count(*) = 28 from pg_attribute where attrelid = to_regclass('app.workflow_runs') and attnum > 0 and not attisdropped)
        and exists (
          select 1 from pg_attribute where attrelid = to_regclass('app.run_checkpoints')
            and attname = 'workflow_version_id' and atttypid = 'uuid'::regtype
            and attnotnull and not attisdropped
        )
        and exists (
          select 1 from pg_attribute where attrelid = to_regclass('app.run_checkpoints')
            and attname = 'last_transition_fingerprint'
            and atttypid = 'character varying'::regtype
            and atttypmod = 68 and not attnotnull and not attisdropped
        )
        and (select count(*) = 12 from pg_attribute where attrelid = to_regclass('app.run_checkpoints') and attnum > 0 and not attisdropped)
        and exists (
          select 1 from pg_constraint where conrelid = to_regclass('app.workflow_runs')
            and conname = 'workflow_runs_workspace_version_identity_unique'
            and pg_get_constraintdef(oid) = 'UNIQUE (workspace_id, id, workflow_version_id)'
        )
        and exists (
          select 1 from pg_constraint where conrelid = to_regclass('app.run_checkpoints')
            and conname = 'run_checkpoints_transition_fingerprint_valid'
            and pg_get_constraintdef(oid) = 'CHECK (((last_transition_fingerprint IS NULL) OR ((last_transition_fingerprint)::text ~ ''^[0-9a-f]{64}$''::text)))'
        )
        and exists (
          select 1 from pg_constraint where conrelid = to_regclass('app.run_checkpoints')
            and conname = 'run_checkpoints_run_version_workspace_fk'
            and pg_get_constraintdef(oid) = 'FOREIGN KEY (workspace_id, workflow_run_id, workflow_version_id) REFERENCES app.workflow_runs(workspace_id, id, workflow_version_id) ON DELETE CASCADE'
        )
        and not exists (
          select 1 from (values
            ('run_events', 'run_events_payload_bounded', 'CHECK ((octet_length((payload)::text) <= 524288))'),
            ('workflow_runs', 'workflow_runs_input_ref_bounded', 'CHECK (((input_ref IS NULL) OR (octet_length((input_ref)::text) <= 4194304)))'),
            ('workflow_runs', 'workflow_runs_output_ref_bounded', 'CHECK (((output_ref IS NULL) OR (octet_length((output_ref)::text) <= 4194304)))'),
            ('run_checkpoints', 'run_checkpoints_scheduler_state_bounded', 'CHECK ((octet_length((scheduler_state)::text) <= 4194304))'),
            ('node_runs', 'node_runs_input_ref_bounded', 'CHECK (((input_ref IS NULL) OR (octet_length((input_ref)::text) <= 4194304)))'),
            ('node_runs', 'node_runs_output_ref_bounded', 'CHECK (((output_ref IS NULL) OR (octet_length((output_ref)::text) <= 4194304)))'),
            ('node_attempts', 'node_attempts_output_ref_bounded', 'CHECK (((output_ref IS NULL) OR (octet_length((output_ref)::text) <= 4194304)))')
          ) expected(table_name, constraint_name, definition)
          where not exists (
            select 1 from pg_constraint constraint_record
            where constraint_record.conrelid = to_regclass('app.' || expected.table_name)
              and constraint_record.conname = expected.constraint_name
              and pg_get_constraintdef(constraint_record.oid) = expected.definition
          )
        )
        and exists (
          select 1 from pg_constraint
          where conrelid = to_regclass('app.workflow_runs')
            and conname = 'workflow_runs_input_ref_expiry_valid'
            and convalidated
            and pg_get_constraintdef(oid) = 'CHECK ((((input_ref IS NULL) AND (input_ref_expires_at IS NULL)) OR ((input_ref IS NOT NULL) AND (input_ref_expires_at IS NOT NULL) AND (input_ref_expires_at > created_at) AND (input_ref_expires_at <= (created_at + ''30 days''::interval)))))'
        )
        and not exists (
          select 1 from (values
            ('workflow_runs', 'workflow_runs_workspace_scope'),
            ('run_events', 'run_events_workspace_scope'),
            ('run_checkpoints', 'run_checkpoints_workspace_scope'),
            ('node_runs', 'node_runs_workspace_scope'),
            ('node_attempts', 'node_attempts_workspace_scope')
          ) expected(table_name, policy_name)
          where (select count(*) from pg_policy where polrelid = to_regclass('app.' || expected.table_name)) <>
                case
                  when expected.table_name = 'node_runs' then 5
                  when expected.table_name = 'workflow_runs' then 4
                  when expected.table_name in ('run_events', 'run_checkpoints') then 4
                  when expected.table_name = 'node_attempts' then 2
                  else 1
                end
            or not exists (
              select 1 from pg_policy policy
              where policy.polrelid = to_regclass('app.' || expected.table_name)
                and policy.polname = expected.policy_name
                and policy.polcmd = '*'
                and cardinality(policy.polroles) = 2
                and (select oid from pg_roles where rolname = $2) = any(policy.polroles)
                and pg_get_expr(policy.polqual, policy.polrelid) = '((workspace_id)::text = NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text))'
                and pg_get_expr(policy.polwithcheck, policy.polrelid) = '((workspace_id)::text = NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text))'
            )
        )
        and exists (
          select 1 from pg_policy policy
          where policy.polrelid = to_regclass('app.artifacts')
            and policy.polname = 'artifacts_workspace_scope'
            and policy.polcmd = '*'
            and cardinality(policy.polroles) = 3
            and (select oid from pg_roles where rolname = $2) = any(policy.polroles)
            and pg_get_expr(policy.polqual, policy.polrelid) = '((workspace_id)::text = NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text))'
            and pg_get_expr(policy.polwithcheck, policy.polrelid) = '((workspace_id)::text = NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text))'
        )
        and not exists (
          select 1 from (values
            ('workflow_runs', 'input_ref'),
            ('workflow_runs', 'input_ref_expires_at')
          ) protected(table_name, column_name)
          where has_column_privilege($2, 'app.' || protected.table_name, protected.column_name, 'UPDATE')
        )
        and has_column_privilege($2, 'app.workflow_runs', 'input_ref', 'SELECT')
        and has_column_privilege($2, 'app.workflow_runs', 'input_ref', 'INSERT')
        and has_column_privilege($2, 'app.workflow_runs', 'input_ref_expires_at', 'SELECT')
        and has_column_privilege($2, 'app.workflow_runs', 'input_ref_expires_at', 'INSERT')
        and not exists (
          select 1 from pg_policy policy, unnest(policy.polroles) runtime_role
          where policy.polrelid = to_regclass('app.workflow_runs')
            and policy.polname = 'workflow_runs_workspace_scope'
            and runtime_role <> (select oid from pg_roles where rolname = $2)
            and (
              not has_column_privilege(pg_get_userbyid(runtime_role), 'app.workflow_runs', 'input_ref', 'SELECT')
              or not has_column_privilege(pg_get_userbyid(runtime_role), 'app.workflow_runs', 'input_ref', 'INSERT')
              or has_column_privilege(pg_get_userbyid(runtime_role), 'app.workflow_runs', 'input_ref', 'UPDATE')
              or not has_column_privilege(pg_get_userbyid(runtime_role), 'app.workflow_runs', 'input_ref_expires_at', 'SELECT')
              or not has_column_privilege(pg_get_userbyid(runtime_role), 'app.workflow_runs', 'input_ref_expires_at', 'INSERT')
              or has_column_privilege(pg_get_userbyid(runtime_role), 'app.workflow_runs', 'input_ref_expires_at', 'UPDATE')
            )
        )
        and not exists (
          select 1 from (values
            ('workflow_runs'), ('run_checkpoints'), ('node_runs'), ('node_attempts')
          ) expected(table_name)
          where not exists (
            select 1 from pg_class table_record
            where table_record.oid = to_regclass('app.' || expected.table_name)
              and table_record.relrowsecurity and table_record.relforcerowsecurity
          )
        )
      ) as execution_values_compatible,
      (
        has_table_privilege($2, 'app.workflow_runs', 'SELECT')
        and not exists (
          select 1 from (values
            ('node_attempts_executor_failure_complete'),
            ('node_attempts_executor_failure_kind_valid'),
            ('node_attempts_executor_error_kind_valid'),
            ('node_attempts_retry_decision_valid'),
            ('node_attempts_executor_failure_only_failed')
          ) expected(constraint_name)
          where not exists (
            select 1 from pg_constraint constraint_record
            where constraint_record.conrelid=to_regclass('app.node_attempts')
              and constraint_record.conname=expected.constraint_name
          )
        )
        and (
          select pg_get_expr(constraint_record.conbin, constraint_record.conrelid)
          from pg_constraint constraint_record
          where constraint_record.conrelid = to_regclass('app.node_runs')
            and constraint_record.conname = 'node_runs_invocation_key_format'
        ) = $invocation_constraint$(((invocation_key)::text ~ '^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,255}$'::text) OR ((invocation_key)::text ~ '^([A-Za-z0-9_.!~*()''-]|%[0-9A-F]{2})+\\|([A-Za-z0-9_.!~*()''-]|%[0-9A-F]{2})+\\|b:([A-Za-z0-9_.!~*()''-]|%[0-9A-F]{2})*\\|i:([A-Za-z0-9_.!~*()''-]|%[0-9A-F]{2})*$'::text))$invocation_constraint$
        and exists (
          select 1 from pg_constraint
          where conrelid=to_regclass('app.node_runs')
            and conname='node_runs_provider_dispatch_binding_format'
        )
        and exists (
          select 1 from pg_constraint
          where conrelid=to_regclass('app.preview_attempts')
            and conname='preview_attempts_provider_dispatch_binding_format'
        )
        and has_table_privilege($2, 'app.run_checkpoints', 'SELECT')
        and has_table_privilege($2, 'app.run_events', 'SELECT')
        and has_table_privilege($2, 'app.node_runs', 'SELECT')
        and has_table_privilege($2, 'app.node_attempts', 'SELECT')
        and has_table_privilege($2, 'app.artifacts', 'SELECT')
        and has_table_privilege($2, 'app.outbox_events', 'SELECT')
        and has_table_privilege($2, 'app.inbox_receipts', 'SELECT')
        and has_table_privilege($2, 'app.inbox_receipts', 'INSERT')
        and has_column_privilege($2, 'app.inbox_receipts', 'completed_at', 'UPDATE')
        and has_table_privilege($2, 'app.transport_security_audit_facts', 'SELECT')
        and has_table_privilege($2, 'app.transport_security_audit_facts', 'INSERT')
        and has_table_privilege($2, 'app.node_runs', 'INSERT')
        and has_table_privilege($2, 'app.node_attempts', 'INSERT')
        and has_column_privilege($2, 'app.node_runs', 'provider_dispatch_binding', 'UPDATE')
        and has_column_privilege($2, 'app.preview_attempts', 'provider_dispatch_binding', 'UPDATE')
        and has_function_privilege(
          $2,
          'app.connection_dispatch_fence_current(uuid,uuid,text,text,uuid)',
          'EXECUTE'
        )
        and has_column_privilege($2, 'app.node_attempts', 'executor_failure_kind', 'UPDATE')
        and has_column_privilege($2, 'app.node_attempts', 'executor_error_kind', 'UPDATE')
        and has_column_privilege($2, 'app.node_attempts', 'executor_possibly_dispatched', 'UPDATE')
        and has_column_privilege($2, 'app.node_attempts', 'retry_decision', 'UPDATE')
        and has_table_privilege($2, 'app.run_events', 'INSERT')
        and has_table_privilege($2, 'app.outbox_events', 'INSERT')
        and has_table_privilege($2, 'app.workflow_runs', 'INSERT')
        and has_table_privilege($2, 'app.run_checkpoints', 'INSERT')
        and not has_table_privilege($2, 'app.run_events', 'UPDATE')
        and not has_table_privilege($2, 'app.outbox_events', 'UPDATE')
        and not has_table_privilege($2, 'app.inbox_receipts', 'UPDATE')
        and not has_table_privilege($2, 'app.transport_security_audit_facts', 'UPDATE')
        and not exists (
          select 1 from information_schema.column_privileges privilege
          where privilege.table_schema='app'
            and privilege.table_name='inbox_receipts'
            and privilege.grantee=$2
            and privilege.privilege_type='UPDATE'
            and privilege.column_name <> 'completed_at'
        )
        and not exists (
          select 1 from (values
            ('workflow_runs'), ('run_checkpoints'), ('run_events'),
            ('node_runs'), ('node_attempts'), ('artifacts'), ('outbox_events'),
            ('inbox_receipts'), ('transport_security_audit_facts')
          ) protected(table_name)
          join pg_class relation
            on relation.oid = to_regclass('app.' || protected.table_name)
          where not relation.relrowsecurity or not relation.relforcerowsecurity
        )
        and not exists (
          select 1
          from information_schema.column_privileges privilege
          where privilege.table_schema='app'
            and privilege.grantee=$2
            and privilege.privilege_type='UPDATE'
            and privilege.table_name in (
              'workflow_runs', 'run_checkpoints', 'node_runs', 'node_attempts'
            )
            and not (
              (privilege.table_name='workflow_runs' and privilege.column_name in (
                'status','started_at','completed_at','output_ref','error_summary','updated_at',
                'deadline_wakeup_at'
              ))
              or (privilege.table_name='run_checkpoints' and privilege.column_name in (
                'revision','engine_version','scheduler_state','resume_at',
                'resume_lease_owner','resume_lease_token','resume_lease_expires_at',
                'updated_at','last_transition_fingerprint'
              ))
              or (privilege.table_name='node_runs' and privilege.column_name in (
                'status','output_ref','current_attempt_id','current_attempt_number',
                 'resume_at','retry_due_at','safe_error_code','updated_at',
                  'started_at','completed_at','due_wakeup_at','control_kind','wait_kind',
                  'provider_dispatch_binding'
              ))
              or (privilege.table_name='node_attempts' and privilege.column_name in (
                'status','lease_owner','lease_expires_at','fence_token',
                 'dispatch_marked_at','output_ref','safe_error_code','error_summary',
                 'reconciliation_ref','updated_at','started_at','completed_at',
                 'executor_failure_kind','executor_error_kind',
                 'executor_possibly_dispatched','retry_decision'
               ))
            )
        )
        and exists (
          select 1 from pg_policy policy
          where policy.polrelid = to_regclass('app.outbox_events')
            and policy.polname = 'outbox_events_tenant_insert'
            and policy.polcmd = 'a'
            and cardinality(policy.polroles) = 2
            and (select oid from pg_roles where rolname = $2) = any(policy.polroles)
            and policy.polqual is null
            and pg_get_expr(policy.polwithcheck, policy.polrelid) = '((workspace_id)::text = NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text))'
        )
        and exists (
          select 1 from pg_policy policy
          where policy.polrelid = to_regclass('app.outbox_events')
            and policy.polname = 'outbox_events_tenant_select'
            and policy.polcmd = 'r'
            and cardinality(policy.polroles) = 2
            and (select oid from pg_roles where rolname = $2) = any(policy.polroles)
            and pg_get_expr(policy.polqual, policy.polrelid) = '((workspace_id)::text = NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text))'
            and policy.polwithcheck is null
        )
        and not exists (
          select 1 from (values
            ('inbox_receipts', 'inbox_receipts_workspace_scope'),
            ('transport_security_audit_facts', 'transport_security_audit_facts_workspace_scope')
          ) expected(table_name, policy_name)
          where not exists (
            select 1 from pg_policy policy
            where policy.polrelid = to_regclass('app.' || expected.table_name)
              and policy.polname = expected.policy_name
              and policy.polcmd = '*'
              and cardinality(policy.polroles) = 2
              and (select oid from pg_roles where rolname = $2) = any(policy.polroles)
              and pg_get_expr(policy.polqual, policy.polrelid) = '((workspace_id)::text = NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text))'
              and pg_get_expr(policy.polwithcheck, policy.polrelid) = '((workspace_id)::text = NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text))'
          )
        )
        and has_column_privilege($2, 'app.workflow_runs', 'status', 'UPDATE')
        and not exists (
          select 1 from (values
            ('workflow_runs', 'started_at'),
            ('workflow_runs', 'completed_at'),
            ('workflow_runs', 'updated_at'),
            ('workflow_runs', 'deadline_wakeup_at'),
            ('run_checkpoints', 'engine_version'),
            ('run_checkpoints', 'scheduler_state'),
            ('run_checkpoints', 'last_transition_fingerprint'),
            ('run_checkpoints', 'resume_at'),
            ('run_checkpoints', 'resume_lease_owner'),
            ('run_checkpoints', 'resume_lease_token'),
            ('run_checkpoints', 'resume_lease_expires_at'),
            ('run_checkpoints', 'updated_at'),
            ('node_runs', 'current_attempt_id'),
            ('node_runs', 'current_attempt_number'),
            ('node_runs', 'resume_at'),
             ('node_runs', 'retry_due_at'),
             ('node_runs', 'due_wakeup_at'),
             ('node_runs', 'control_kind'),
             ('node_runs', 'wait_kind'),
            ('node_runs', 'completed_at'),
            ('node_runs', 'safe_error_code'),
            ('node_runs', 'updated_at')
          ) required(table_name, column_name)
          where not has_column_privilege(
            $2,
            'app.' || required.table_name,
            required.column_name,
            'UPDATE'
          )
        )
        and has_column_privilege($2, 'app.run_checkpoints', 'revision', 'UPDATE')
        and has_column_privilege($2, 'app.run_checkpoints', 'scheduler_state', 'UPDATE')
        and has_column_privilege($2, 'app.node_runs', 'status', 'UPDATE')
        and has_column_privilege($2, 'app.node_attempts', 'status', 'UPDATE')
        and not has_column_privilege($2, 'app.run_checkpoints', 'workflow_version_id', 'UPDATE')
        and not exists (
          select 1 from (values
            ('workflow_runs'), ('run_checkpoints'), ('run_events'),
            ('node_runs'), ('node_attempts'), ('artifacts'), ('outbox_events'),
            ('inbox_receipts'), ('transport_security_audit_facts')
          ) protected(table_name)
          where has_table_privilege($2, 'app.' || protected.table_name, 'DELETE')
             or has_table_privilege($2, 'app.' || protected.table_name, 'TRUNCATE')
             or has_table_privilege($2, 'app.' || protected.table_name, 'REFERENCES')
             or has_table_privilege($2, 'app.' || protected.table_name, 'TRIGGER')
        )
      ) as coordinator_run_store_compatible,`;
