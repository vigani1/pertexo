ALTER TABLE app.workflow_runs
  ADD CONSTRAINT workflow_runs_workspace_version_identity_unique
    UNIQUE (workspace_id, id, workflow_version_id);

ALTER TABLE app.run_checkpoints
  ADD COLUMN workflow_version_id uuid,
  ADD COLUMN last_transition_fingerprint varchar(64),
  ADD CONSTRAINT run_checkpoints_transition_fingerprint_valid
    CHECK (
      last_transition_fingerprint IS NULL
      OR last_transition_fingerprint ~ '^[0-9a-f]{64}$'
    );

ALTER TABLE app.workflow_runs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.run_checkpoints NO FORCE ROW LEVEL SECURITY;

UPDATE app.run_checkpoints checkpoint
SET workflow_version_id = run.workflow_version_id
FROM app.workflow_runs run
WHERE run.workspace_id = checkpoint.workspace_id
  AND run.id = checkpoint.workflow_run_id;

ALTER TABLE app.workflow_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE app.run_checkpoints FORCE ROW LEVEL SECURITY;

ALTER TABLE app.run_checkpoints
  ALTER COLUMN workflow_version_id SET NOT NULL,
  ADD CONSTRAINT run_checkpoints_run_version_workspace_fk
    FOREIGN KEY (workspace_id, workflow_run_id, workflow_version_id)
    REFERENCES app.workflow_runs (workspace_id, id, workflow_version_id)
    ON DELETE CASCADE;

GRANT UPDATE (last_transition_fingerprint)
  ON app.run_checkpoints TO {{worker_runtime_role}};

-- The application contract is exactly 4 KiB of canonical JSON. PostgreSQL's
-- jsonb::text adds formatting whitespace and can expand exponent-form numbers,
-- so this constraint is deliberately only a conservative storage backstop.
ALTER TABLE app.run_events
  DROP CONSTRAINT run_events_payload_bounded,
  ADD CONSTRAINT run_events_payload_bounded
    CHECK (octet_length(payload::text) <= 524288);
