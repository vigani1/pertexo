ALTER TABLE app.node_runs
  ADD COLUMN wait_kind varchar(32),
  DROP CONSTRAINT node_runs_wait_state_valid;

UPDATE app.node_runs
   SET wait_kind = CASE
     WHEN resume_at IS NOT NULL THEN 'node_wait'
     WHEN retry_due_at IS NOT NULL THEN 'retry_backoff'
     ELSE NULL
   END
 WHERE status = 'waiting' AND control_kind IS NULL;

ALTER TABLE app.node_runs
  ADD CONSTRAINT node_runs_wait_kind_valid CHECK (
    wait_kind IS NULL OR wait_kind IN ('node_wait', 'retry_backoff')
  ),
  ADD CONSTRAINT node_runs_wait_state_valid CHECK (
    (
      status = 'waiting' AND control_kind = 'for_each_barrier'
      AND wait_kind IS NULL AND resume_at IS NULL AND retry_due_at IS NULL
    ) OR (
      status = 'waiting' AND control_kind IS NULL
      AND ((wait_kind = 'node_wait' AND resume_at IS NOT NULL AND retry_due_at IS NULL)
        OR (wait_kind = 'retry_backoff' AND resume_at IS NULL AND retry_due_at IS NOT NULL))
    ) OR (
      status <> 'waiting' AND control_kind IS NULL AND wait_kind IS NULL
      AND resume_at IS NULL AND retry_due_at IS NULL
    )
  );

ALTER TABLE app.node_attempts
  ADD COLUMN admission_kind varchar(32) NOT NULL DEFAULT 'execute',
  ADD CONSTRAINT node_attempts_admission_kind_valid CHECK (
    admission_kind IN ('execute', 'retry', 'wait_resume')
  );

ALTER TABLE app.workflow_runs
  ADD COLUMN deadline_wakeup_at timestamptz,
  ADD CONSTRAINT workflow_runs_deadline_wakeup_consistent CHECK (
    deadline_wakeup_at IS NULL OR deadline_wakeup_at = deadline_at
  );
CREATE INDEX workflow_runs_due_deadline_idx
  ON app.workflow_runs (deadline_at, id)
  WHERE deadline_at IS NOT NULL
    AND status IN ('queued', 'running', 'waiting')
    AND deadline_wakeup_at IS NULL;

GRANT UPDATE (wait_kind) ON app.node_runs TO {{worker_runtime_role}};
GRANT UPDATE (deadline_wakeup_at) ON app.workflow_runs TO {{worker_runtime_role}};
GRANT SELECT, UPDATE (deadline_wakeup_at) ON app.workflow_runs TO {{owner_role}};

CREATE POLICY workflow_runs_deadline_wakeup_owner_select
  ON app.workflow_runs FOR SELECT TO {{owner_role}} USING (true);
CREATE POLICY workflow_runs_deadline_wakeup_owner_update
  ON app.workflow_runs FOR UPDATE TO {{owner_role}} USING (true) WITH CHECK (true);

CREATE FUNCTION app.claim_due_workflow_run_deadlines(p_limit integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE claimed_count integer;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'due workflow deadline limit must be between 1 and 100'
      USING ERRCODE = '22023';
  END IF;

  WITH due AS MATERIALIZED (
    SELECT run.id, run.workspace_id, run.deadline_at
      FROM app.workflow_runs run
     WHERE run.status IN ('queued', 'running', 'waiting')
       AND run.deadline_at <= clock_timestamp()
       AND run.deadline_wakeup_at IS DISTINCT FROM run.deadline_at
     ORDER BY run.deadline_at, run.id
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  ), marked AS (
    UPDATE app.workflow_runs run
       SET deadline_wakeup_at = due.deadline_at,
           updated_at = clock_timestamp()
      FROM due WHERE run.id = due.id
    RETURNING run.id, run.workspace_id
  ), events AS (
    SELECT marked.*, gen_random_uuid() AS outbox_event_id FROM marked
  )
  INSERT INTO app.outbox_events (
    id, workspace_id, job_name, schema_version, aggregate_type,
    aggregate_id, payload, payload_checksum
  )
  SELECT outbox_event_id, workspace_id, 'advance-workflow-run', 1,
         'workflow-run', id,
         jsonb_build_object('outboxEventId', outbox_event_id, 'runId', id,
           'schemaVersion', 1, 'workspaceId', workspace_id),
         encode(sha256(convert_to(
           '{"outboxEventId":"' || outbox_event_id::text ||
           '","runId":"' || id::text ||
           '","schemaVersion":1,"workspaceId":"' || workspace_id::text || '"}',
           'UTF8')), 'hex')
    FROM events;
  GET DIAGNOSTICS claimed_count = ROW_COUNT;
  RETURN claimed_count;
END;
$function$;

ALTER FUNCTION app.claim_due_workflow_run_deadlines(integer) OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.claim_due_workflow_run_deadlines(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_due_workflow_run_deadlines(integer)
  TO {{worker_runtime_role}};
