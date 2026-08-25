ALTER TABLE app.workflow_runs
  ADD COLUMN input_ref_expires_at timestamptz;

UPDATE app.workflow_runs
   SET input_ref_expires_at=created_at + interval '30 days'
 WHERE input_ref IS NOT NULL;

ALTER TABLE app.workflow_runs
  ADD CONSTRAINT workflow_runs_input_ref_expiry_valid CHECK (
    (input_ref IS NULL AND input_ref_expires_at IS NULL)
    OR (
      input_ref IS NOT NULL
      AND input_ref_expires_at IS NOT NULL
      AND input_ref_expires_at > created_at
      AND input_ref_expires_at <= created_at + interval '30 days'
    )
  ) NOT VALID;

ALTER TABLE app.workflow_runs
  VALIDATE CONSTRAINT workflow_runs_input_ref_expiry_valid;
