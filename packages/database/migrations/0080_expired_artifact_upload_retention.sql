-- ADR 035: expired public uploads use the existing dual-region retention
-- coordinator. A pending upload is charged until both regions confirm that
-- its bytes are gone; deletion failures remain deleting and are retried.

CREATE OR REPLACE FUNCTION app.find_due_run_artifact_retention(p_limit integer)
RETURNS TABLE(workspace_id uuid,artifact_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 25 THEN
    RAISE EXCEPTION 'invalid run artifact retention discovery limit'
      USING ERRCODE='22023';
  END IF;
  RETURN QUERY SELECT artifact.workspace_id,artifact.id
  FROM app.artifacts artifact
  WHERE (
      (artifact.status='pending' AND artifact.purpose='user-upload'
        AND artifact.expires_at<=clock_timestamp())
      OR (artifact.status='available' AND artifact.expires_at<=clock_timestamp())
      OR artifact.status='deleting'
    )
    AND (artifact.retention_retry_at IS NULL
      OR artifact.retention_retry_at<=clock_timestamp())
    AND NOT EXISTS (SELECT 1 FROM app.artifact_links link
      WHERE link.workspace_id=artifact.workspace_id
        AND link.artifact_id=artifact.id)
  ORDER BY artifact.expires_at,artifact.id LIMIT p_limit;
END $$;

CREATE OR REPLACE FUNCTION app.prepare_run_artifact_retention(
  p_workspace_id uuid,p_artifact_id uuid,p_expected_control_sequence bigint,
  p_expected_control_hash char(64)
) RETURNS varchar LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_artifact app.artifacts%ROWTYPE;
BEGIN
  IF p_workspace_id IS NULL OR p_artifact_id IS NULL
    OR p_expected_control_sequence IS NULL OR p_expected_control_sequence<0
    OR p_expected_control_hash IS NULL
    OR p_expected_control_hash!~'^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid run artifact retention step' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM app.workspaces workspace WHERE workspace.id=p_workspace_id
    AND workspace.retention_control_sequence=p_expected_control_sequence
    AND workspace.retention_control_hash=p_expected_control_hash FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'retention control high water changed' USING ERRCODE='40001';
  END IF;
  SELECT * INTO v_artifact FROM app.artifacts artifact
    WHERE artifact.workspace_id=p_workspace_id AND artifact.id=p_artifact_id
    FOR UPDATE;
  IF NOT FOUND THEN RETURN 'stale'; END IF;
  IF v_artifact.status='pending' THEN
    IF v_artifact.purpose<>'user-upload'
      OR v_artifact.expires_at>clock_timestamp() THEN RETURN 'stale'; END IF;
  ELSIF v_artifact.status='available' THEN
    IF v_artifact.expires_at>clock_timestamp() THEN RETURN 'stale'; END IF;
  ELSIF v_artifact.status<>'deleting' THEN
    RETURN 'stale';
  ELSIF v_artifact.retention_retry_at IS NOT NULL
    AND v_artifact.retention_retry_at>clock_timestamp() THEN
    RETURN 'stale';
  END IF;
  IF EXISTS (SELECT 1 FROM app.workspace_legal_holds hold
      WHERE hold.workspace_id=p_workspace_id AND hold.released_at IS NULL) THEN
    UPDATE app.artifacts SET retention_retry_at=clock_timestamp()+interval '1 day',
      updated_at=clock_timestamp() WHERE id=p_artifact_id;
    RETURN 'held';
  END IF;
  IF EXISTS (SELECT 1 FROM app.artifact_links link
      WHERE link.workspace_id=p_workspace_id AND link.artifact_id=p_artifact_id)
    OR EXISTS (SELECT 1 FROM app.workflow_runs run WHERE run.workspace_id=p_workspace_id
      AND (app.jsonb_references_artifact(run.input_ref,p_artifact_id)
        OR app.jsonb_references_artifact(run.output_ref,p_artifact_id)))
    OR EXISTS (SELECT 1 FROM app.node_runs node WHERE node.workspace_id=p_workspace_id
      AND (app.jsonb_references_artifact(node.input_ref,p_artifact_id)
        OR app.jsonb_references_artifact(node.output_ref,p_artifact_id)))
    OR EXISTS (SELECT 1 FROM app.node_attempts attempt
      WHERE attempt.workspace_id=p_workspace_id
        AND (app.jsonb_references_artifact(attempt.output_ref,p_artifact_id)
          OR app.jsonb_references_artifact(attempt.reconciliation_ref,p_artifact_id)))
    OR EXISTS (SELECT 1 FROM app.run_events event WHERE event.workspace_id=p_workspace_id
      AND app.jsonb_references_artifact(event.payload,p_artifact_id))
    OR EXISTS (SELECT 1 FROM app.run_checkpoints checkpoint
      WHERE checkpoint.workspace_id=p_workspace_id
        AND app.jsonb_references_artifact(checkpoint.scheduler_state,p_artifact_id)) THEN
    UPDATE app.artifacts SET retention_retry_at=clock_timestamp()+interval '1 day',
      updated_at=clock_timestamp() WHERE id=p_artifact_id;
    RETURN 'referenced';
  END IF;
  UPDATE app.artifacts SET status='deleting',
    retention_retry_at=clock_timestamp()+interval '1 minute',
    updated_at=clock_timestamp() WHERE id=p_artifact_id;
  RETURN 'artifact';
END $$;

CREATE OR REPLACE FUNCTION app.defer_run_artifact_retention(
  p_workspace_id uuid,p_artifact_id uuid,p_expected_control_sequence bigint,
  p_expected_control_hash char(64)
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
BEGIN
  PERFORM 1 FROM app.workspaces workspace WHERE workspace.id=p_workspace_id
    AND workspace.retention_control_sequence=p_expected_control_sequence
    AND workspace.retention_control_hash=p_expected_control_hash FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'retention control high water changed' USING ERRCODE='40001';
  END IF;
  UPDATE app.artifacts SET retention_retry_at=clock_timestamp()+interval '1 minute',
    updated_at=clock_timestamp()
    WHERE workspace_id=p_workspace_id AND id=p_artifact_id AND status='deleting';
  RETURN FOUND;
END $$;
