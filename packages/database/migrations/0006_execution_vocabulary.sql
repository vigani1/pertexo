ALTER TABLE app.workflow_runs
  DROP CONSTRAINT workflow_runs_status_valid;

UPDATE app.workflow_runs
SET status = 'canceled',
    updated_at = now()
WHERE status = 'cancelled';

ALTER TABLE app.workflow_runs
  ADD CONSTRAINT workflow_runs_status_valid
  CHECK (
    status IN (
      'queued',
      'running',
      'waiting',
      'succeeded',
      'failed',
      'canceled',
      'timed_out',
      'outcome_unknown'
    )
  );

ALTER TABLE app.idempotency_records
  DROP CONSTRAINT idempotency_records_status_valid;

UPDATE app.idempotency_records
SET status = 'in_progress',
    updated_at = now()
WHERE status = 'claimed';

ALTER TABLE app.idempotency_records
  ADD CONSTRAINT idempotency_records_status_valid
  CHECK (status IN ('in_progress', 'completed', 'failed'));

GRANT UPDATE (status, result_ref, updated_at)
  ON app.idempotency_records
  TO {{api_runtime_role}};
