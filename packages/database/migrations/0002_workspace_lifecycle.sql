-- Workspace deletion and restore change the workspace in the request's own
-- transaction (src/lifecycle/workspace-deletion.ts), and the worker purges a
-- workspace in bounded pages (src/lifecycle/workspace-purge.ts). The leased
-- lifecycle commands, the hash-linked control ledger and its audit facts, and
-- the purge jobs, steps and completions go.
--
-- Still to port: preview cleanup and run-artifact retention read the
-- workspace control columns as a fence, and several reapers check the
-- legal-hold table. Both stay, unchanged and no longer written, until those
-- areas move to TypeScript.

DROP TRIGGER workspaces_apply_deletion_side_effects ON app.workspaces;
DROP TRIGGER workspaces_apply_invitation_deletion_side_effects ON app.workspaces;
DROP TRIGGER workspaces_arm_control_projection ON app.workspaces;
DROP TRIGGER workspaces_controlled_lifecycle_mutation ON app.workspaces;
DROP TRIGGER workspaces_incomplete_deletion_guard ON app.workspaces;
DROP TRIGGER workspaces_retention_control_initial_state ON app.workspaces;
DROP TRIGGER workspace_lifecycle_operations_controlled_mutation
  ON app.workspace_lifecycle_operations;
DROP TRIGGER workspace_legal_holds_ledger_links ON app.workspace_legal_holds;

DROP TABLE app.workspace_purge_steps CASCADE;
DROP TABLE app.workspace_purge_completions CASCADE;
DROP TABLE app.workspace_purge_jobs CASCADE;
DROP TABLE app.workspace_control_ledger_projection CASCADE;
DROP TABLE app.retention_control_audit_facts CASCADE;
DROP TABLE app.retention_batches CASCADE;
DROP TABLE app.retention_schedule_state CASCADE;
DROP TABLE app.operator_maintenance_rerun_requests CASCADE;

DROP FUNCTION app.apply_workspace_deletion_side_effects();
DROP FUNCTION app.apply_workspace_invitation_deletion_side_effects();
DROP FUNCTION app.arm_workspace_control_projection();
DROP FUNCTION app.authorize_workspace_lifecycle_append(uuid, uuid, bigint);
DROP FUNCTION app.authorize_workspace_purge_completion_append(uuid, uuid, bigint, bigint, character);
DROP FUNCTION app.block_incomplete_workspace_deletion();
DROP FUNCTION app.checkpoint_workspace_object_versions_page(uuid, uuid, bigint, integer, boolean, bigint, character);
DROP FUNCTION app.claim_workspace_lifecycle_operations(character varying, integer, interval);
DROP FUNCTION app.claim_workspace_purge_step(uuid, bigint, character, character varying, interval);
DROP FUNCTION app.complete_workspace_lifecycle_operation(uuid, uuid, bigint, bigint, character);
DROP FUNCTION app.enforce_workspace_legal_hold_ledger_links();
DROP FUNCTION app.enforce_workspace_retention_control_initial_state();
DROP FUNCTION app.execute_workspace_tenant_rows_page(uuid, uuid, bigint, integer, bigint, character);
DROP FUNCTION app.execute_workspace_tenant_rows_page_before_folders(uuid, uuid, bigint, integer, bigint, character);
DROP FUNCTION app.execute_workspace_tenant_rows_page_before_input_cases(uuid, uuid, bigint, integer, bigint, character);
DROP FUNCTION app.execute_workspace_tenant_rows_page_before_organization(uuid, uuid, bigint, integer, bigint, character);
DROP FUNCTION app.fail_workspace_lifecycle_operation(uuid, uuid, bigint, character varying);
DROP FUNCTION app.find_due_workspace_purge();
DROP FUNCTION app.find_due_workspace_purge_completion();
DROP FUNCTION app.find_due_workspace_purge_step();
DROP FUNCTION app.lock_workspace_lifecycle_operation(uuid, uuid, bigint);
DROP FUNCTION app.prepare_workspace_purge_completion(uuid, bigint, character, character varying, interval);
DROP FUNCTION app.prepare_workspace_purge_job(uuid, bigint, character, character varying, interval);
DROP FUNCTION app.project_and_complete_workspace_lifecycle_operation(uuid, uuid, bigint, bigint, character, character);
DROP FUNCTION app.project_workspace_deletion(uuid, bigint, uuid, character varying, uuid, character, character, character varying, character varying, character varying, timestamp with time zone, interval);
DROP FUNCTION app.project_workspace_purge_completion(uuid, uuid, bigint, bigint, character, character);
DROP FUNCTION app.project_workspace_purge_started(uuid, uuid, bigint, bigint, character, character);
DROP FUNCTION app.read_workspace_lifecycle_operation(uuid, uuid, uuid);
DROP FUNCTION app.reject_retention_control_fact_mutation();
DROP FUNCTION app.reject_workspace_control_direct_mutation();
DROP FUNCTION app.reject_workspace_lifecycle_operation_direct_mutation();
DROP FUNCTION app.reject_workspace_purge_direct_mutation();
DROP FUNCTION app.release_workspace_lifecycle_operation(uuid, uuid, bigint);
DROP FUNCTION app.release_workspace_purge_completion(uuid, uuid, bigint);
DROP FUNCTION app.release_workspace_purge_job(uuid, uuid, bigint);
DROP FUNCTION app.release_workspace_purge_step(uuid, uuid, bigint);
DROP FUNCTION app.request_workspace_lifecycle_operation(uuid, uuid, character, character varying, uuid, character varying, character);

-- A lifecycle operation is the receipt of one request, written as it happens.
DROP INDEX app.workspace_lifecycle_operations_claim_idx;
DROP INDEX app.workspace_lifecycle_operations_workspace_status_idx;
ALTER TABLE app.workspace_lifecycle_operations
  DROP COLUMN status, DROP COLUMN attempt_count, DROP COLUMN lease_owner,
  DROP COLUMN lease_token, DROP COLUMN lease_fence, DROP COLUMN lease_acquired_at,
  DROP COLUMN lease_expires_at, DROP COLUMN control_sequence,
  DROP COLUMN control_record_hash, DROP COLUMN error_code, DROP COLUMN updated_at,
  DROP COLUMN completed_at, DROP COLUMN append_authorized_at;

GRANT SELECT, INSERT ON app.workspace_lifecycle_operations TO {{app_role}};
CREATE POLICY workspace_lifecycle_operations_workspace_scope
  ON app.workspace_lifecycle_operations TO {{app_role}}
  USING (workspace_id::text = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK (workspace_id::text = NULLIF(current_setting('app.workspace_id', true), ''));
GRANT UPDATE (status, deletion_requested_at, deletion_requested_by,
  deletion_reason, purge_after) ON app.workspaces TO {{app_role}};

-- History tables refuse deletes except while their workspace is purging.
CREATE OR REPLACE FUNCTION app.workspace_purge_immutable_delete_is_armed(p_workspace_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM app.workspaces WHERE id = p_workspace_id AND status = 'purging'
  )
$$;
GRANT EXECUTE ON FUNCTION app.workspace_purge_immutable_delete_is_armed(uuid)
  TO {{app_role}}, {{maintenance_role}};

-- Owner purge policies served the removed purge functions.
DROP POLICY inbox_receipts_owner_leased_purge_delete ON app.inbox_receipts;
DROP POLICY inbox_receipts_owner_leased_purge_lock ON app.inbox_receipts;
DROP POLICY inbox_receipts_owner_leased_purge_select ON app.inbox_receipts;
DROP POLICY outbox_events_owner_leased_purge_delete ON app.outbox_events;

-- The maintenance role purges any workspace's rows and runs retention.
DROP POLICY workflow_runs_retention ON app.workflow_runs;
DROP POLICY node_runs_retention ON app.node_runs;
DROP POLICY run_events_retention ON app.run_events;
DROP POLICY run_checkpoints_retention ON app.run_checkpoints;
DROP POLICY webhook_trigger_replay_records_retention ON app.webhook_trigger_replay_records;
DROP POLICY webhook_trigger_deliveries_retention ON app.webhook_trigger_deliveries;
DROP POLICY trigger_schedule_occurrences_retention ON app.trigger_schedule_occurrences;
DROP POLICY audit_events_retention ON app.audit_events;
DROP POLICY transport_security_audit_facts_retention ON app.transport_security_audit_facts;

DO $$
DECLARE
  v_table text;
BEGIN
  FOR v_table IN
    SELECT DISTINCT table_class.relname
    FROM pg_attribute attribute
    JOIN pg_class table_class ON table_class.oid = attribute.attrelid
    JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
    WHERE namespace.nspname = 'app' AND table_class.relkind = 'r'
      AND attribute.attname IN ('workspace_id', 'resource_id', 'prior_workspace_id')
      AND NOT attribute.attisdropped AND table_class.relname <> 'workspaces'
  LOOP
    EXECUTE format('GRANT SELECT, DELETE ON app.%I TO %s', v_table, '{{maintenance_role}}');
    EXECUTE format(
      'CREATE POLICY %I ON app.%I TO %s USING (true) WITH CHECK (true)',
      v_table || '_maintenance', v_table, '{{maintenance_role}}');
  END LOOP;
END $$;

GRANT SELECT, UPDATE (status, name, slug, created_by, deletion_requested_by,
  deletion_reason, updated_at) ON app.workspaces TO {{maintenance_role}};
GRANT UPDATE (current_attempt_id, current_attempt_number)
  ON app.node_runs TO {{maintenance_role}};
GRANT UPDATE (actor_user_id, request_id, trace_id, metadata, target_id)
  ON app.audit_events TO {{maintenance_role}};
GRANT UPDATE (metadata, resource_id, resource_type, idempotency_key)
  ON app.usage_events TO {{maintenance_role}};
GRANT UPDATE (consumer_name, message_id)
  ON app.transport_security_audit_facts TO {{maintenance_role}};
GRANT UPDATE (published_version_id) ON app.workflows TO {{maintenance_role}};
GRANT EXECUTE ON FUNCTION app.workspace_invitation_replacement_claim_is_reapable(uuid, uuid, character)
  TO {{maintenance_role}};
