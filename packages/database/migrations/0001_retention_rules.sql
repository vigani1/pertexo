-- Retention runs as TypeScript rules under the maintenance role
-- (src/lifecycle/retention.ts): no batches, schedules, dry runs or operator
-- reruns. The batch, schedule and rerun tables stay until the workspace purge
-- that still deletes them is replaced.

DROP TRIGGER workspaces_provision_retention_schedule ON app.workspaces;
DROP TRIGGER retention_batches_controlled_mutation ON app.retention_batches;

DROP FUNCTION app.provision_retention_schedule_state();
DROP FUNCTION app.reject_retention_batch_direct_mutation();
DROP FUNCTION app.schedule_workflow_run_input_retention(integer);
DROP FUNCTION app.start_retention_batch(uuid, uuid, character varying, character varying, timestamp with time zone, boolean, character varying, character varying);
DROP FUNCTION app.claim_retention_batches(character varying, integer, integer);
DROP FUNCTION app.claim_retention_destructive_batches(character varying, integer, integer);
DROP FUNCTION app.claim_retention_dry_run_batches(character varying, integer, integer);
DROP FUNCTION app.checkpoint_retention_batch(uuid, uuid, bigint, timestamp with time zone, uuid, integer, integer, boolean);
DROP FUNCTION app.release_retention_batch(uuid, uuid, bigint);
DROP FUNCTION app.execute_standard_retention_page(uuid, uuid, bigint, integer, bigint, character);
DROP FUNCTION app.execute_standard_retention_dry_run_page(uuid, uuid, bigint, integer);
DROP FUNCTION app.execute_workflow_run_input_retention_page(uuid, uuid, bigint, integer, bigint, character);
DROP FUNCTION app.execute_workflow_run_input_retention_dry_run_page(uuid, uuid, bigint, integer);
DROP FUNCTION app.standard_retention_dry_run_stage_keys(uuid, character varying, character varying, timestamp with time zone, jsonb, jsonb, boolean, integer);
DROP FUNCTION app.request_operator_maintenance_rerun(uuid, uuid, character varying, uuid, character varying, character varying, boolean);
DROP FUNCTION app.process_operator_maintenance_rerun();

ALTER TABLE app.operator_commands
  DROP CONSTRAINT operator_commands_type_valid,
  ADD CONSTRAINT operator_commands_type_valid CHECK (command_type IN (
    'outbox.redispatch', 'attempt.reconcile', 'due-work.resume',
    'unknown-outcome.record-evidence', 'run.cancel', 'run.replay',
    'trigger.reconcile'));

-- The rules read across workspaces and remove only what they cover.
GRANT SELECT, DELETE ON
  app.workflow_runs, app.node_runs, app.run_events, app.run_checkpoints,
  app.webhook_trigger_replay_records, app.webhook_trigger_deliveries,
  app.trigger_schedule_occurrences, app.audit_events,
  app.transport_security_audit_facts
TO {{maintenance_role}};
GRANT UPDATE (input_ref, input_ref_expires_at, output_ref, error_summary,
  cancel_reason, details_purged_at, updated_at)
ON app.workflow_runs TO {{maintenance_role}};

CREATE POLICY workflow_runs_retention ON app.workflow_runs
  TO {{maintenance_role}} USING (true) WITH CHECK (true);
CREATE POLICY node_runs_retention ON app.node_runs
  TO {{maintenance_role}} USING (true);
CREATE POLICY run_events_retention ON app.run_events
  TO {{maintenance_role}} USING (true);
CREATE POLICY run_checkpoints_retention ON app.run_checkpoints
  TO {{maintenance_role}} USING (true);
CREATE POLICY webhook_trigger_replay_records_retention
  ON app.webhook_trigger_replay_records TO {{maintenance_role}} USING (true);
CREATE POLICY webhook_trigger_deliveries_retention
  ON app.webhook_trigger_deliveries TO {{maintenance_role}} USING (true);
CREATE POLICY trigger_schedule_occurrences_retention
  ON app.trigger_schedule_occurrences TO {{maintenance_role}} USING (true);
CREATE POLICY audit_events_retention ON app.audit_events
  TO {{maintenance_role}} USING (true);
CREATE POLICY transport_security_audit_facts_retention
  ON app.transport_security_audit_facts TO {{maintenance_role}} USING (true);

-- Health commands are removed with their observation from any caller,
-- including retention, which works across workspaces.
CREATE OR REPLACE FUNCTION app.cleanup_connection_health_command() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
DECLARE v_prior_workspace text := current_setting('app.workspace_id', true);
BEGIN
  PERFORM set_config('app.workspace_id', OLD.workspace_id::text, true);
  DELETE FROM app.outbox_events WHERE workspace_id=OLD.workspace_id AND id=OLD.outbox_event_id
    AND job_name='apply-connection-health-observation';
  PERFORM set_config('app.workspace_id', coalesce(v_prior_workspace, ''), true);
  RETURN OLD;
END $$;
