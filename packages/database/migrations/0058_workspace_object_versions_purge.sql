-- ADR 013/027 version-aware object erasure. Physical S3 work remains outside
-- PostgreSQL; this migration provides ordered, fenced, legal-hold-safe progress.

ALTER TABLE app.workspace_purge_steps
  DROP CONSTRAINT workspace_purge_steps_name_valid,
  ADD CONSTRAINT workspace_purge_steps_name_valid
    CHECK (step_name IN ('object_versions','tenant_rows'));

-- Existing purges must perform object erasure before any remaining tenant-row
-- work. Reset old tenant leases so no pre-migration claimant can bypass it.
SELECT set_config('app.workspace_purge_transition','on',true);
INSERT INTO app.workspace_purge_steps(job_id,step_name)
SELECT job.id,'object_versions' FROM app.workspace_purge_jobs job
WHERE job.status='purging' ON CONFLICT DO NOTHING;
UPDATE app.workspace_purge_steps step SET status='pending',lease_owner=NULL,
  lease_token=NULL,lease_acquired_at=NULL,lease_expires_at=NULL,
  updated_at=clock_timestamp()
FROM app.workspace_purge_jobs job
WHERE job.id=step.job_id AND job.status='purging'
  AND step.step_name='tenant_rows' AND step.status='running';

CREATE OR REPLACE FUNCTION app.project_workspace_purge_started(
  p_job_id uuid,p_lease_token uuid,p_lease_fence bigint,p_sequence bigint,
  p_previous_hash char(64),p_record_hash char(64)
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_job app.workspace_purge_jobs%ROWTYPE;
DECLARE v_projected boolean;
BEGIN
  SELECT * INTO v_job FROM app.workspace_purge_jobs WHERE id=p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.status<>'running' OR v_job.lease_token<>p_lease_token
    OR v_job.lease_fence<>p_lease_fence OR v_job.lease_expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'workspace purge lease is stale' USING ERRCODE='55000';
  END IF;
  v_projected:=app.project_workspace_deletion(v_job.workspace_id,p_sequence,
    v_job.command_id,'purge_started',v_job.workspace_id,p_previous_hash,p_record_hash,
    v_job.actor_ref,NULL,v_job.reason,v_job.occurred_at,interval '30 days');
  PERFORM set_config('app.workspace_purge_transition','on',true);
  INSERT INTO app.workspace_purge_steps(job_id,step_name)
    SELECT v_job.id,step_name FROM unnest(ARRAY['object_versions','tenant_rows']) step_name
    ON CONFLICT DO NOTHING;
  UPDATE app.workspace_purge_jobs SET status='purging',control_sequence=p_sequence,
    control_record_hash=p_record_hash,lease_owner=NULL,lease_token=NULL,
    lease_acquired_at=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
  WHERE id=v_job.id;
  RETURN v_projected;
END $$;

CREATE OR REPLACE FUNCTION app.find_due_workspace_purge_step()
RETURNS TABLE(job_id uuid,workspace_id uuid) LANGUAGE sql SECURITY DEFINER STABLE
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
  SELECT job.id,job.workspace_id FROM app.workspace_purge_jobs job
  JOIN app.workspace_purge_steps step ON step.job_id=job.id
  WHERE job.status='purging' AND (step.status='pending'
      OR (step.status='running' AND step.lease_expires_at<=clock_timestamp()))
    AND (step.step_name='object_versions' OR (step.step_name='tenant_rows' AND EXISTS (
      SELECT 1 FROM app.workspace_purge_steps object_step
      WHERE object_step.job_id=job.id AND object_step.step_name='object_versions'
        AND object_step.status='completed')))
    AND NOT EXISTS (SELECT 1 FROM app.workspace_legal_holds hold
      WHERE hold.workspace_id=job.workspace_id AND hold.released_sequence IS NULL)
  ORDER BY CASE step.step_name WHEN 'object_versions' THEN 0 ELSE 1 END,
    step.updated_at,job.id LIMIT 1
$$;

CREATE OR REPLACE FUNCTION app.claim_workspace_purge_step(
  p_job_id uuid,p_projected_sequence bigint,p_projected_hash char(64),
  p_lease_owner varchar,p_lease_interval interval
) RETURNS TABLE(step_name varchar,lease_token uuid,lease_fence bigint)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_job app.workspace_purge_jobs%ROWTYPE;
DECLARE v_workspace app.workspaces%ROWTYPE;
DECLARE v_now timestamptz:=clock_timestamp();
BEGIN
  IF p_job_id IS NULL OR p_projected_sequence IS NULL OR p_projected_sequence<1
    OR p_projected_hash IS NULL OR p_projected_hash!~'^[0-9a-f]{64}$'
    OR p_lease_owner IS NULL OR length(btrim(p_lease_owner)) NOT BETWEEN 1 AND 128
    OR p_lease_interval IS NULL OR p_lease_interval<=interval '0 seconds'
    OR p_lease_interval>interval '5 minutes' THEN
    RAISE EXCEPTION 'invalid workspace purge step claim' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_job FROM app.workspace_purge_jobs WHERE id=p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.status<>'purging' THEN
    RAISE EXCEPTION 'workspace purge is not in progress' USING ERRCODE='55000';
  END IF;
  SELECT * INTO STRICT v_workspace FROM app.workspaces
    WHERE id=v_job.workspace_id FOR UPDATE;
  IF v_workspace.status<>'purging'
    OR v_workspace.retention_control_sequence<>p_projected_sequence
    OR v_workspace.retention_control_hash<>p_projected_hash THEN
    RAISE EXCEPTION 'workspace purge destructive high water is not exact'
      USING ERRCODE='40001';
  END IF;
  IF EXISTS (SELECT 1 FROM app.workspace_legal_holds hold
    WHERE hold.workspace_id=v_job.workspace_id AND hold.released_sequence IS NULL) THEN
    RAISE EXCEPTION 'active workspace legal hold blocks destructive purge step'
      USING ERRCODE='55000';
  END IF;
  PERFORM set_config('app.workspace_purge_transition','on',true);
  RETURN QUERY WITH candidate AS (
    SELECT step.ctid FROM app.workspace_purge_steps step
    WHERE step.job_id=v_job.id AND (step.status='pending'
        OR (step.status='running' AND step.lease_expires_at<=v_now))
      AND (step.step_name='object_versions' OR (step.step_name='tenant_rows' AND EXISTS (
        SELECT 1 FROM app.workspace_purge_steps object_step
        WHERE object_step.job_id=v_job.id AND object_step.step_name='object_versions'
          AND object_step.status='completed')))
    ORDER BY CASE step.step_name WHEN 'object_versions' THEN 0 ELSE 1 END
    LIMIT 1 FOR UPDATE
  ), claimed AS (
    UPDATE app.workspace_purge_steps step SET status='running',
      attempt_count=step.attempt_count+1,lease_owner=btrim(p_lease_owner),
      lease_token=gen_random_uuid(),lease_fence=step.lease_fence+1,
      lease_acquired_at=v_now,lease_expires_at=v_now+p_lease_interval,updated_at=v_now
    FROM candidate WHERE step.ctid=candidate.ctid RETURNING step.*
  ) SELECT claimed.step_name,claimed.lease_token,claimed.lease_fence FROM claimed;
END $$;

CREATE FUNCTION app.checkpoint_workspace_object_versions_page(
  p_job_id uuid,p_lease_token uuid,p_lease_fence bigint,p_deleted_count integer,
  p_completed boolean,p_projected_sequence bigint,p_projected_hash char(64)
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_job app.workspace_purge_jobs%ROWTYPE;
DECLARE v_step app.workspace_purge_steps%ROWTYPE;
BEGIN
  IF p_job_id IS NULL OR p_lease_token IS NULL OR p_lease_fence IS NULL
    OR p_deleted_count IS NULL OR p_completed IS NULL
    OR (p_completed AND p_deleted_count<>0)
    OR (NOT p_completed AND p_deleted_count NOT BETWEEN 1 AND 500)
    OR p_projected_sequence IS NULL OR p_projected_sequence<1
    OR p_projected_hash IS NULL OR p_projected_hash!~'^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid workspace object purge checkpoint' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_job FROM app.workspace_purge_jobs WHERE id=p_job_id FOR UPDATE;
  SELECT * INTO v_step FROM app.workspace_purge_steps
    WHERE job_id=p_job_id AND step_name='object_versions' FOR UPDATE;
  IF NOT FOUND OR v_job.status<>'purging' OR v_step.status<>'running'
    OR v_step.lease_token<>p_lease_token OR v_step.lease_fence<>p_lease_fence
    OR v_step.lease_expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'workspace object purge lease is stale' USING ERRCODE='55000';
  END IF;
  PERFORM 1 FROM app.workspaces workspace WHERE workspace.id=v_job.workspace_id
    AND workspace.status='purging'
    AND workspace.retention_control_sequence=p_projected_sequence
    AND workspace.retention_control_hash=p_projected_hash FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace object purge high water changed' USING ERRCODE='40001';
  END IF;
  IF EXISTS (SELECT 1 FROM app.workspace_legal_holds hold
      WHERE hold.workspace_id=v_job.workspace_id AND hold.released_sequence IS NULL) THEN
    RAISE EXCEPTION 'active workspace legal hold blocks object purge checkpoint'
      USING ERRCODE='55000';
  END IF;
  PERFORM set_config('app.workspace_purge_transition','on',true);
  UPDATE app.workspace_purge_steps SET status=CASE WHEN p_completed THEN 'completed' ELSE 'pending' END,
    lease_owner=NULL,lease_token=NULL,lease_acquired_at=NULL,lease_expires_at=NULL,
    updated_at=clock_timestamp(),completed_at=CASE WHEN p_completed THEN clock_timestamp() END
    WHERE job_id=p_job_id AND step_name='object_versions';
  RETURN p_completed;
END $$;

CREATE OR REPLACE FUNCTION app.block_incomplete_workspace_deletion()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
BEGIN
  IF NEW.status='deleted' AND OLD.status IS DISTINCT FROM 'deleted'
    AND NOT EXISTS (
      SELECT 1 FROM app.workspace_purge_jobs job
      WHERE job.workspace_id=NEW.id AND job.status='completed'
        AND EXISTS (SELECT 1 FROM app.workspace_purge_steps step
          WHERE step.job_id=job.id AND step.step_name='tenant_rows'
            AND step.status='completed')
        AND EXISTS (SELECT 1 FROM app.workspace_purge_steps step
          WHERE step.job_id=job.id AND step.step_name='object_versions'
            AND step.status='completed')
        AND NOT EXISTS (SELECT 1 FROM app.workspace_purge_steps incomplete
          WHERE incomplete.job_id=job.id AND incomplete.status<>'completed')
    ) THEN
    RAISE EXCEPTION 'workspace purge is incomplete' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION app.checkpoint_workspace_object_versions_page(
  uuid,uuid,bigint,integer,boolean,bigint,char)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},
    {{lifecycle_command_role}};
GRANT EXECUTE ON FUNCTION app.checkpoint_workspace_object_versions_page(
  uuid,uuid,bigint,integer,boolean,bigint,char) TO {{maintenance_role}};
