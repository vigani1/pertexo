ALTER TABLE app.node_runs
  ADD COLUMN due_wakeup_at timestamptz,
  ADD CONSTRAINT node_runs_due_wakeup_consistent CHECK (
    due_wakeup_at IS NULL OR (
      status = 'waiting'
      AND due_wakeup_at = coalesce(retry_due_at, resume_at)
    )
  );

CREATE INDEX node_runs_due_wakeup_idx
  ON app.node_runs (coalesce(retry_due_at, resume_at), id)
  WHERE status = 'waiting' AND coalesce(retry_due_at, resume_at) IS NOT NULL;

GRANT UPDATE (due_wakeup_at) ON app.node_runs TO {{worker_runtime_role}};

-- FORCE ROW LEVEL SECURITY still applies to table owners. These owner-only
-- policies are the narrow authority used by the global SECURITY DEFINER scan.
CREATE POLICY node_runs_due_wakeup_owner_select
  ON app.node_runs FOR SELECT TO {{owner_role}} USING (true);
CREATE POLICY node_runs_due_wakeup_owner_update
  ON app.node_runs FOR UPDATE TO {{owner_role}} USING (true) WITH CHECK (true);
CREATE POLICY outbox_events_due_wakeup_owner_insert
  ON app.outbox_events FOR INSERT TO {{owner_role}} WITH CHECK (true);

CREATE FUNCTION app.claim_due_node_run_wakeups(p_limit integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  claimed_count integer;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'due node wakeup limit must be between 1 and 100'
      USING ERRCODE = '22023';
  END IF;

  WITH due AS MATERIALIZED (
    SELECT node.id, node.workspace_id, node.workflow_run_id,
           coalesce(node.retry_due_at, node.resume_at) AS due_at
      FROM app.node_runs node
     WHERE node.status = 'waiting'
       AND coalesce(node.retry_due_at, node.resume_at) <= clock_timestamp()
       AND node.due_wakeup_at IS DISTINCT FROM
           coalesce(node.retry_due_at, node.resume_at)
     ORDER BY coalesce(node.retry_due_at, node.resume_at), node.id
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  ), marked AS (
    UPDATE app.node_runs node
       SET due_wakeup_at = due.due_at,
           updated_at = clock_timestamp()
      FROM due
     WHERE node.id = due.id
     RETURNING node.workspace_id, node.workflow_run_id
  ), events AS (
    SELECT marked.workspace_id, marked.workflow_run_id,
           gen_random_uuid() AS outbox_event_id
      FROM marked
  )
  INSERT INTO app.outbox_events (
    id, workspace_id, job_name, schema_version, aggregate_type,
    aggregate_id, payload, payload_checksum
  )
  SELECT event.outbox_event_id, event.workspace_id, 'advance-workflow-run', 1,
         'workflow-run', event.workflow_run_id,
         jsonb_build_object(
           'outboxEventId', event.outbox_event_id,
           'runId', event.workflow_run_id,
           'schemaVersion', 1,
           'workspaceId', event.workspace_id
         ),
         encode(sha256(convert_to(
           '{"outboxEventId":"' || event.outbox_event_id::text ||
           '","runId":"' || event.workflow_run_id::text ||
           '","schemaVersion":1,"workspaceId":"' || event.workspace_id::text || '"}',
           'UTF8'
         )), 'hex')
    FROM events event;

  GET DIAGNOSTICS claimed_count = ROW_COUNT;
  RETURN claimed_count;
END;
$function$;

ALTER FUNCTION app.claim_due_node_run_wakeups(integer) OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.claim_due_node_run_wakeups(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_due_node_run_wakeups(integer)
  TO {{worker_runtime_role}};
