-- Operator commands (outbox redispatch, attempt reconciliation, due-work
-- resume, run cancel, unknown-outcome evidence, trigger reconciliation and
-- run replay) run as statements in TypeScript under the maintenance role, and
-- the replay worker completes its command in its own transaction. A command
-- belongs to the workspace it targets, so its row carries that workspace and
-- is isolated like any other; status reads no longer look the workspace up
-- through audit events. The redispatch result is written whole, so the
-- prior-attempt columns and the trigger that copied them go.

DROP FUNCTION app.cancel_operator_run(uuid, uuid, uuid, varchar, varchar, boolean);
DROP FUNCTION app.resume_operator_due_work(uuid, uuid, uuid, varchar, varchar, boolean);
DROP FUNCTION app.record_operator_unknown_outcome_evidence(uuid, uuid, uuid, varchar, jsonb, varchar, varchar);
DROP FUNCTION app.reconcile_operator_attempt(uuid, uuid, uuid, bigint, varchar, varchar, varchar, boolean);
DROP FUNCTION app.execute_operator_execution_command(uuid, varchar, uuid, uuid, bigint, varchar, varchar, jsonb, varchar, varchar, boolean);
DROP FUNCTION app.retry_operator_trigger_reconciliation(uuid, uuid, uuid, varchar, varchar, boolean);
DROP FUNCTION app.request_operator_run_replay(uuid, uuid, uuid, uuid, jsonb, varchar, varchar, boolean);
DROP FUNCTION app.complete_operator_run_replay(uuid, uuid, uuid);
DROP FUNCTION app.fail_operator_run_replay(uuid, uuid, varchar);
DROP FUNCTION app.get_operator_command(uuid, uuid, varchar, varchar);
DROP FUNCTION app.redispatch_failed_outbox_event(uuid, uuid, uuid, varchar, varchar, boolean);
DROP TRIGGER operator_commands_result_default ON app.operator_commands;
DROP FUNCTION app.populate_operator_command_result();
-- 0013 dropped this; 0017 recreated it by mistake, with no trigger to call it.
DROP FUNCTION app.reject_preview_run_pin_change();

DROP POLICY outbox_events_operator_command_select ON app.outbox_events;
DROP POLICY outbox_events_operator_command_update ON app.outbox_events;
DROP POLICY operator_unknown_evidence_owner_all ON app.operator_unknown_outcome_evidence;

ALTER TABLE app.operator_commands ADD COLUMN workspace_id uuid;
UPDATE app.operator_commands command SET workspace_id = coalesce(
  (SELECT request.workspace_id FROM app.operator_run_replay_requests request
    WHERE request.command_id = command.id),
  (SELECT evidence.workspace_id FROM app.operator_unknown_outcome_evidence evidence
    WHERE evidence.command_id = command.id),
  (SELECT audit.workspace_id FROM app.audit_events audit
    WHERE audit.request_id = command.id::text
      AND audit.action LIKE 'operator.%'
      AND audit.action <> 'operator.command_status'
      AND NOT (audit.metadata ? 'replayed')
    LIMIT 1));
-- Only a purged workspace's commands have nothing left to name it.
DELETE FROM app.operator_commands WHERE workspace_id IS NULL;
ALTER TABLE app.operator_commands
  ALTER COLUMN workspace_id SET NOT NULL,
  ADD CONSTRAINT operator_commands_workspace_fk FOREIGN KEY (workspace_id)
    REFERENCES app.workspaces(id),
  DROP CONSTRAINT operator_commands_prior_attempts_valid,
  DROP COLUMN prior_publish_attempts,
  DROP COLUMN prior_failed_at,
  DROP COLUMN prior_error_code;
CREATE INDEX operator_commands_workspace_idx
  ON app.operator_commands (workspace_id);

ALTER TABLE app.operator_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.operator_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY operator_commands_maintenance ON app.operator_commands
  TO {{maintenance_role}} USING (true) WITH CHECK (true);
CREATE POLICY operator_commands_workspace_scope ON app.operator_commands
  TO {{app_role}}
  USING ((workspace_id)::text = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ((workspace_id)::text = NULLIF(current_setting('app.workspace_id', true), ''));

-- The operator writes its command, audit, outbox, run event, evidence and
-- replay rows, and changes only the columns its commands own.
GRANT SELECT, INSERT, DELETE ON app.operator_commands TO {{maintenance_role}};
GRANT INSERT ON app.audit_events, app.outbox_events, app.run_events,
  app.operator_unknown_outcome_evidence, app.operator_run_replay_requests
  TO {{maintenance_role}};
GRANT UPDATE (status, fence_token, lease_owner, lease_expires_at,
  reconciliation_ref, completed_at, updated_at)
  ON app.node_attempts TO {{maintenance_role}};
GRANT UPDATE (status, completed_at, due_wakeup_at, updated_at)
  ON app.node_runs TO {{maintenance_role}};
GRANT UPDATE (resume_at, resume_lease_owner, resume_lease_token,
  resume_lease_expires_at, updated_at)
  ON app.run_checkpoints TO {{maintenance_role}};
GRANT UPDATE (cancel_requested_at, cancel_requested_by)
  ON app.workflow_runs TO {{maintenance_role}};

-- The replay worker settles its own request and command.
GRANT SELECT, UPDATE (status, outcome, result, completed_at)
  ON app.operator_commands TO {{app_role}};
GRANT UPDATE (status, result_run_id, safe_error_code, completed_at)
  ON app.operator_run_replay_requests TO {{app_role}};
