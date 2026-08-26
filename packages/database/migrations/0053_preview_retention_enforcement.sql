-- ADR 013 preview retention enforcement. External object deletion is permitted
-- only after the maintenance coordinator holds the workspace control lock and
-- proves the exact dual-region ledger high water.

CREATE TABLE pertexo_internal.preview_retention_transition_capabilities (
  transaction_id xid8 NOT NULL,
  workspace_id uuid NOT NULL,
  artifact_id uuid NOT NULL,
  target_status varchar(32) NOT NULL,
  PRIMARY KEY (transaction_id,workspace_id,artifact_id,target_status),
  CHECK (target_status IN ('deleting','deleted'))
);
REVOKE ALL ON pertexo_internal.preview_retention_transition_capabilities
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},
    {{maintenance_role}},{{lifecycle_command_role}};

CREATE FUNCTION app.guard_preview_artifact_destruction()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pertexo_internal,pg_temp AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
    AND NEW.status IN ('deleting','deleted')
    AND EXISTS (
      SELECT 1 FROM app.artifact_links link
      WHERE link.workspace_id=OLD.workspace_id AND link.artifact_id=OLD.id
        AND link.owner_kind='preview_run'
    ) AND NOT EXISTS (
      SELECT 1 FROM pertexo_internal.preview_retention_transition_capabilities capability
      WHERE capability.transaction_id=pg_current_xact_id()
        AND capability.workspace_id=OLD.workspace_id
        AND capability.artifact_id=OLD.id
        AND capability.target_status=NEW.status
    ) THEN
    RAISE EXCEPTION 'preview artifact destruction requires maintenance authority'
      USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER artifacts_preview_destruction_guard
  BEFORE UPDATE OF status ON app.artifacts
  FOR EACH ROW EXECUTE FUNCTION app.guard_preview_artifact_destruction();

CREATE POLICY preview_runs_owner_retention_inventory ON app.preview_runs
  FOR SELECT TO {{owner_role}} USING (true);

CREATE FUNCTION app.find_due_preview_cleanup(p_limit integer)
RETURNS TABLE(workspace_id uuid,preview_run_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 25 THEN
    RAISE EXCEPTION 'invalid preview cleanup discovery limit' USING ERRCODE='22023';
  END IF;
  RETURN QUERY
    SELECT preview.workspace_id,preview.id
    FROM app.preview_runs preview
    WHERE preview.expires_at<=clock_timestamp()
      AND preview.status IN ('succeeded','failed','canceled','timed_out','outcome_unknown')
      AND NOT EXISTS (
        SELECT 1 FROM app.preview_runs child
        WHERE child.workspace_id=preview.workspace_id
          AND child.prior_preview_run_id=preview.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM app.workspace_legal_holds hold
        WHERE hold.workspace_id=preview.workspace_id AND hold.released_at IS NULL
      )
    ORDER BY preview.expires_at,preview.id LIMIT p_limit;
END $$;

CREATE FUNCTION app.prepare_preview_cleanup_step(
  p_workspace_id uuid,p_preview_run_id uuid,p_quiescence_seconds integer,
  p_expected_control_sequence bigint,p_expected_control_hash char(64)
) RETURNS TABLE(outcome varchar,artifact_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_artifact app.artifacts%ROWTYPE;
  v_preview app.preview_runs%ROWTYPE;
BEGIN
  IF p_workspace_id IS NULL OR p_preview_run_id IS NULL
    OR p_quiescence_seconds IS NULL OR p_quiescence_seconds NOT BETWEEN 1 AND 120
    OR p_expected_control_sequence IS NULL OR p_expected_control_sequence<0
    OR p_expected_control_hash IS NULL
    OR p_expected_control_hash!~'^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid preview cleanup preparation' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('app.workspace_id',p_workspace_id::text,true);
  PERFORM 1 FROM app.workspaces workspace
    WHERE workspace.id=p_workspace_id
      AND workspace.retention_control_sequence=p_expected_control_sequence
      AND workspace.retention_control_hash=p_expected_control_hash
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'preview control high water changed' USING ERRCODE='40001';
  END IF;
  IF EXISTS (SELECT 1 FROM app.workspace_legal_holds hold
      WHERE hold.workspace_id=p_workspace_id AND hold.released_at IS NULL) THEN
    RETURN QUERY SELECT 'held'::varchar,NULL::uuid;
    RETURN;
  END IF;
  SELECT * INTO v_preview FROM app.preview_runs preview
    WHERE preview.workspace_id=p_workspace_id AND preview.id=p_preview_run_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'completed'::varchar,NULL::uuid;
    RETURN;
  END IF;
  IF v_preview.expires_at>clock_timestamp()
    OR v_preview.status NOT IN ('succeeded','failed','canceled','timed_out','outcome_unknown')
    OR EXISTS (SELECT 1 FROM app.preview_runs child
      WHERE child.workspace_id=p_workspace_id
        AND child.prior_preview_run_id=p_preview_run_id) THEN
    RETURN QUERY SELECT 'blocked'::varchar,NULL::uuid;
    RETURN;
  END IF;
  SELECT artifact.* INTO v_artifact
    FROM app.artifact_links link JOIN app.artifacts artifact
      ON artifact.workspace_id=link.workspace_id AND artifact.id=link.artifact_id
    WHERE link.workspace_id=p_workspace_id AND link.owner_kind='preview_run'
      AND link.owner_id=p_preview_run_id AND artifact.status<>'deleted'
    ORDER BY artifact.id LIMIT 1 FOR UPDATE OF artifact;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'finish'::varchar,NULL::uuid;
    RETURN;
  END IF;
  IF v_artifact.status IN ('pending','available') THEN
    INSERT INTO pertexo_internal.preview_retention_transition_capabilities
      (transaction_id,workspace_id,artifact_id,target_status)
    VALUES (pg_current_xact_id(),p_workspace_id,v_artifact.id,'deleting');
    UPDATE app.artifacts SET status='deleting',updated_at=clock_timestamp()
      WHERE workspace_id=p_workspace_id AND id=v_artifact.id;
    DELETE FROM pertexo_internal.preview_retention_transition_capabilities capability
      WHERE capability.transaction_id=pg_current_xact_id()
        AND capability.workspace_id=p_workspace_id
        AND capability.artifact_id=v_artifact.id
        AND capability.target_status='deleting';
    RETURN QUERY SELECT 'waiting'::varchar,NULL::uuid;
    RETURN;
  END IF;
  IF v_artifact.updated_at>clock_timestamp()
      -make_interval(secs=>p_quiescence_seconds) THEN
    RETURN QUERY SELECT 'waiting'::varchar,NULL::uuid;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'artifact'::varchar,v_artifact.id;
END $$;

CREATE FUNCTION app.complete_preview_artifact_cleanup(
  p_workspace_id uuid,p_artifact_id uuid,p_expected_control_sequence bigint,
  p_expected_control_hash char(64)
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_completed boolean;
BEGIN
  IF p_workspace_id IS NULL OR p_artifact_id IS NULL
    OR p_expected_control_sequence IS NULL OR p_expected_control_sequence<0
    OR p_expected_control_hash IS NULL
    OR p_expected_control_hash!~'^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid preview artifact completion' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('app.workspace_id',p_workspace_id::text,true);
  PERFORM 1 FROM app.workspaces workspace
    WHERE workspace.id=p_workspace_id
      AND workspace.retention_control_sequence=p_expected_control_sequence
      AND workspace.retention_control_hash=p_expected_control_hash FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'preview control high water changed' USING ERRCODE='40001';
  END IF;
  IF EXISTS (SELECT 1 FROM app.workspace_legal_holds hold
      WHERE hold.workspace_id=p_workspace_id AND hold.released_at IS NULL) THEN
    RETURN false;
  END IF;
  INSERT INTO pertexo_internal.preview_retention_transition_capabilities
    (transaction_id,workspace_id,artifact_id,target_status)
  VALUES (pg_current_xact_id(),p_workspace_id,p_artifact_id,'deleted');
  UPDATE app.artifacts artifact SET status='deleted',deleted_at=clock_timestamp(),
    updated_at=clock_timestamp()
  WHERE artifact.workspace_id=p_workspace_id AND artifact.id=p_artifact_id
    AND artifact.status='deleting' AND EXISTS (
      SELECT 1 FROM app.artifact_links link
      WHERE link.workspace_id=p_workspace_id AND link.artifact_id=p_artifact_id
        AND link.owner_kind='preview_run'
    );
  v_completed:=FOUND;
  DELETE FROM pertexo_internal.preview_retention_transition_capabilities capability
    WHERE capability.transaction_id=pg_current_xact_id()
      AND capability.workspace_id=p_workspace_id
      AND capability.artifact_id=p_artifact_id
      AND capability.target_status='deleted';
  RETURN v_completed;
END $$;

CREATE FUNCTION app.finish_preview_cleanup(
  p_workspace_id uuid,p_preview_run_id uuid,p_expected_control_sequence bigint,
  p_expected_control_hash char(64)
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_preview app.preview_runs%ROWTYPE;
BEGIN
  IF p_workspace_id IS NULL OR p_preview_run_id IS NULL
    OR p_expected_control_sequence IS NULL OR p_expected_control_sequence<0
    OR p_expected_control_hash IS NULL
    OR p_expected_control_hash!~'^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid preview cleanup completion' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('app.workspace_id',p_workspace_id::text,true);
  PERFORM 1 FROM app.workspaces workspace
    WHERE workspace.id=p_workspace_id
      AND workspace.retention_control_sequence=p_expected_control_sequence
      AND workspace.retention_control_hash=p_expected_control_hash FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'preview control high water changed' USING ERRCODE='40001';
  END IF;
  IF EXISTS (SELECT 1 FROM app.workspace_legal_holds hold
      WHERE hold.workspace_id=p_workspace_id AND hold.released_at IS NULL) THEN
    RETURN false;
  END IF;
  SELECT * INTO v_preview FROM app.preview_runs preview
    WHERE preview.workspace_id=p_workspace_id AND preview.id=p_preview_run_id FOR UPDATE;
  IF NOT FOUND THEN RETURN true; END IF;
  IF v_preview.expires_at>clock_timestamp()
    OR v_preview.status NOT IN ('succeeded','failed','canceled','timed_out','outcome_unknown')
    OR EXISTS (SELECT 1 FROM app.preview_runs child
      WHERE child.workspace_id=p_workspace_id AND child.prior_preview_run_id=p_preview_run_id)
    OR EXISTS (SELECT 1 FROM app.artifact_links link JOIN app.artifacts artifact
      ON artifact.workspace_id=link.workspace_id AND artifact.id=link.artifact_id
      WHERE link.workspace_id=p_workspace_id AND link.owner_kind='preview_run'
        AND link.owner_id=p_preview_run_id AND artifact.status<>'deleted') THEN
    RETURN false;
  END IF;
  WITH removed_links AS (
    DELETE FROM app.artifact_links WHERE workspace_id=p_workspace_id
      AND owner_kind='preview_run' AND owner_id=p_preview_run_id RETURNING artifact_id
  ) DELETE FROM app.artifacts artifact USING removed_links
    WHERE artifact.workspace_id=p_workspace_id AND artifact.id=removed_links.artifact_id
      AND artifact.status='deleted';
  DELETE FROM app.preview_attempts WHERE workspace_id=p_workspace_id
    AND preview_run_id=p_preview_run_id;
  DELETE FROM app.idempotency_records WHERE workspace_id=p_workspace_id
    AND operation='preview.execute' AND resource_id=p_preview_run_id
    AND expires_at<=clock_timestamp();
  DELETE FROM app.preview_runs WHERE workspace_id=p_workspace_id AND id=p_preview_run_id;
  RETURN true;
END $$;

ALTER TABLE app.inbox_receipts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.outbox_events NO FORCE ROW LEVEL SECURITY;
DELETE FROM app.inbox_receipts receipt USING app.outbox_events event
WHERE receipt.consumer_name='preview-retention-cleaner'
  AND receipt.message_id=event.id AND event.job_name='sweep-expired-previews';
DELETE FROM app.outbox_events WHERE job_name='sweep-expired-previews';
ALTER TABLE app.inbox_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE app.outbox_events FORCE ROW LEVEL SECURITY;

REVOKE EXECUTE ON FUNCTION app.complete_preview_cleanup(uuid,uuid)
  FROM {{worker_runtime_role}};
REVOKE ALL ON FUNCTION app.guard_preview_artifact_destruction(),
  app.find_due_preview_cleanup(integer),
  app.prepare_preview_cleanup_step(uuid,uuid,integer,bigint,char),
  app.complete_preview_artifact_cleanup(uuid,uuid,bigint,char),
  app.finish_preview_cleanup(uuid,uuid,bigint,char)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},{{lifecycle_command_role}};
GRANT EXECUTE ON FUNCTION app.find_due_preview_cleanup(integer),
  app.prepare_preview_cleanup_step(uuid,uuid,integer,bigint,char),
  app.complete_preview_artifact_cleanup(uuid,uuid,bigint,char),
  app.finish_preview_cleanup(uuid,uuid,bigint,char)
  TO {{maintenance_role}};
