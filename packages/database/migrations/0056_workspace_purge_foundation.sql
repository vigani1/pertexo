-- ADR 013/027 workspace purge foundation. This migration starts the
-- authoritative purge lifecycle but deliberately performs no tenant deletion.

CREATE TABLE app.workspace_purge_jobs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL UNIQUE REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  command_id uuid NOT NULL UNIQUE,
  actor_ref varchar(128) NOT NULL,
  reason varchar(512) NOT NULL,
  occurred_at timestamptz NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'ready',
  lease_owner varchar(128),
  lease_token uuid,
  lease_fence bigint NOT NULL DEFAULT 0,
  lease_acquired_at timestamptz,
  lease_expires_at timestamptz,
  control_sequence bigint,
  control_record_hash char(64),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  CONSTRAINT workspace_purge_jobs_status_valid
    CHECK (status IN ('ready','running','purging','completed')),
  CONSTRAINT workspace_purge_jobs_material_valid CHECK (
    length(btrim(actor_ref)) BETWEEN 1 AND 128
    AND length(btrim(reason)) BETWEEN 1 AND 512
  ),
  CONSTRAINT workspace_purge_jobs_fence_nonnegative CHECK (lease_fence>=0),
  CONSTRAINT workspace_purge_jobs_lease_valid CHECK (
    (lease_owner IS NULL AND lease_token IS NULL AND lease_acquired_at IS NULL
      AND lease_expires_at IS NULL)
    OR (status='running' AND length(btrim(lease_owner)) BETWEEN 1 AND 128
      AND lease_token IS NOT NULL AND lease_acquired_at IS NOT NULL
      AND lease_expires_at>lease_acquired_at
      AND lease_expires_at<=lease_acquired_at+interval '5 minutes')
  ),
  CONSTRAINT workspace_purge_jobs_projection_valid CHECK (
    (status IN ('ready','running') AND control_sequence IS NULL
      AND control_record_hash IS NULL AND completed_at IS NULL)
    OR (status='purging' AND control_sequence IS NOT NULL
      AND control_record_hash~'^[0-9a-f]{64}$' AND completed_at IS NULL)
    OR (status='completed' AND control_sequence IS NOT NULL
      AND control_record_hash~'^[0-9a-f]{64}$' AND completed_at IS NOT NULL)
  )
);
CREATE INDEX workspace_purge_jobs_claim_idx ON app.workspace_purge_jobs(created_at,id)
  WHERE status IN ('ready','running');

CREATE TABLE app.workspace_purge_steps (
  job_id uuid NOT NULL REFERENCES app.workspace_purge_jobs(id) ON DELETE RESTRICT,
  step_name varchar(32) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  last_error_code varchar(64),
  lease_owner varchar(128),
  lease_token uuid,
  lease_fence bigint NOT NULL DEFAULT 0,
  lease_acquired_at timestamptz,
  lease_expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  PRIMARY KEY (job_id,step_name),
  CONSTRAINT workspace_purge_steps_name_valid CHECK (step_name='tenant_rows'),
  CONSTRAINT workspace_purge_steps_status_valid CHECK (status IN ('pending','running','completed')),
  CONSTRAINT workspace_purge_steps_attempt_nonnegative CHECK (attempt_count>=0),
  CONSTRAINT workspace_purge_steps_fence_nonnegative CHECK (lease_fence>=0),
  CONSTRAINT workspace_purge_steps_lease_valid CHECK (
    (lease_owner IS NULL AND lease_token IS NULL AND lease_acquired_at IS NULL
      AND lease_expires_at IS NULL)
    OR (status='running' AND length(btrim(lease_owner)) BETWEEN 1 AND 128
      AND lease_token IS NOT NULL AND lease_acquired_at IS NOT NULL
      AND lease_expires_at>lease_acquired_at
      AND lease_expires_at<=lease_acquired_at+interval '5 minutes')
  ),
  CONSTRAINT workspace_purge_steps_error_valid CHECK (
    last_error_code IS NULL OR last_error_code~'^[a-z][a-z0-9_.:-]{0,63}$'
  ),
  CONSTRAINT workspace_purge_steps_completion_valid CHECK (
    (status='completed' AND completed_at IS NOT NULL)
    OR (status<>'completed' AND completed_at IS NULL)
  )
);

ALTER TABLE app.workspace_purge_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workspace_purge_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE app.workspace_purge_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workspace_purge_steps FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_purge_jobs_owner_all ON app.workspace_purge_jobs
  FOR ALL TO {{owner_role}} USING (true) WITH CHECK (true);
CREATE POLICY workspace_purge_steps_owner_all ON app.workspace_purge_steps
  FOR ALL TO {{owner_role}} USING (true) WITH CHECK (true);

CREATE FUNCTION app.reject_workspace_purge_direct_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF current_setting('app.workspace_purge_transition',true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'workspace purge state changes only through maintenance functions'
      USING ERRCODE='55000';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER workspace_purge_jobs_controlled_mutation
  BEFORE UPDATE OR DELETE ON app.workspace_purge_jobs FOR EACH ROW
  EXECUTE FUNCTION app.reject_workspace_purge_direct_mutation();
CREATE TRIGGER workspace_purge_steps_controlled_mutation
  BEFORE UPDATE OR DELETE ON app.workspace_purge_steps FOR EACH ROW
  EXECUTE FUNCTION app.reject_workspace_purge_direct_mutation();

CREATE FUNCTION app.find_due_workspace_purge()
RETURNS TABLE(workspace_id uuid) LANGUAGE sql SECURITY DEFINER STABLE
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
  SELECT workspace.id FROM app.workspaces workspace
  LEFT JOIN app.workspace_purge_jobs job ON job.workspace_id=workspace.id
  WHERE (workspace.status='pending_deletion' AND workspace.purge_after<=clock_timestamp()
      AND job.id IS NULL)
    OR (job.status='ready' OR (job.status='running' AND job.lease_expires_at<=clock_timestamp()))
  ORDER BY coalesce(job.created_at,workspace.purge_after),workspace.id LIMIT 1
$$;

CREATE FUNCTION app.workspace_purge_repair_command_id(p_workspace_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_command_id uuid;
BEGIN
  IF p_workspace_id IS NULL THEN
    RAISE EXCEPTION 'workspace purge workspace is required' USING ERRCODE='22023';
  END IF;
  SELECT job.command_id INTO v_command_id FROM app.workspace_purge_jobs job
    WHERE job.workspace_id=p_workspace_id;
  RETURN v_command_id;
END $$;

CREATE FUNCTION app.prepare_workspace_purge_job(
  p_workspace_id uuid,p_projected_sequence bigint,p_projected_hash char(64),
  p_lease_owner varchar,p_lease_interval interval
) RETURNS TABLE(job_id uuid,command_id uuid,actor_ref varchar,reason varchar,
  occurred_at timestamptz,lease_token uuid,lease_fence bigint)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_workspace app.workspaces%ROWTYPE;
DECLARE v_job app.workspace_purge_jobs%ROWTYPE;
DECLARE v_now timestamptz:=date_trunc('milliseconds',clock_timestamp());
DECLARE v_existing boolean;
BEGIN
  IF p_workspace_id IS NULL OR p_projected_sequence IS NULL OR p_projected_sequence<0
    OR p_projected_hash IS NULL OR p_projected_hash!~'^[0-9a-f]{64}$'
    OR p_lease_owner IS NULL OR length(btrim(p_lease_owner)) NOT BETWEEN 1 AND 128
    OR p_lease_interval IS NULL OR p_lease_interval<=interval '0 seconds'
    OR p_lease_interval>interval '5 minutes' THEN
    RAISE EXCEPTION 'invalid workspace purge preparation' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_workspace FROM app.workspaces WHERE id=p_workspace_id FOR UPDATE;
  IF NOT FOUND OR v_workspace.status<>'pending_deletion'
    OR v_workspace.purge_after>v_now THEN
    RAISE EXCEPTION 'workspace is not ready for purge' USING ERRCODE='55P03';
  END IF;
  IF v_workspace.retention_control_sequence<>p_projected_sequence
    OR v_workspace.retention_control_hash<>p_projected_hash THEN
    RAISE EXCEPTION 'workspace purge control high water changed' USING ERRCODE='40001';
  END IF;
  SELECT * INTO v_job FROM app.workspace_purge_jobs
    WHERE workspace_id=p_workspace_id FOR UPDATE;
  v_existing:=FOUND;
  IF NOT v_existing THEN
    PERFORM set_config('app.workspace_purge_transition','on',true);
    INSERT INTO app.workspace_purge_jobs
      (id,workspace_id,command_id,actor_ref,reason,occurred_at)
    VALUES (gen_random_uuid(),p_workspace_id,gen_random_uuid(),
      'maintenance:workspace-purge','Authoritative workspace purge started',v_now);
  ELSIF v_job.status NOT IN ('ready','running')
    OR (v_job.status='running' AND v_job.lease_expires_at>v_now) THEN
    RAISE EXCEPTION 'workspace purge job is not claimable' USING ERRCODE='55P03';
  END IF;
  PERFORM set_config('app.workspace_purge_transition','on',true);
  RETURN QUERY WITH claimed AS (
    UPDATE app.workspace_purge_jobs job SET status='running',lease_owner=btrim(p_lease_owner),
      lease_token=gen_random_uuid(),lease_fence=job.lease_fence+1,lease_acquired_at=v_now,
      lease_expires_at=v_now+p_lease_interval,updated_at=v_now
    WHERE job.workspace_id=p_workspace_id RETURNING job.*
  ) SELECT claimed.id,claimed.command_id,claimed.actor_ref,claimed.reason,
      claimed.occurred_at,claimed.lease_token,claimed.lease_fence FROM claimed;
END $$;

CREATE FUNCTION app.release_workspace_purge_job(
  p_job_id uuid,p_lease_token uuid,p_lease_fence bigint
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_changed integer;
BEGIN
  PERFORM set_config('app.workspace_purge_transition','on',true);
  UPDATE app.workspace_purge_jobs SET status='ready',lease_owner=NULL,lease_token=NULL,
    lease_acquired_at=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
  WHERE id=p_job_id AND status='running' AND lease_token=p_lease_token
    AND lease_fence=p_lease_fence AND lease_expires_at>clock_timestamp();
  GET DIAGNOSTICS v_changed=ROW_COUNT;
  RETURN v_changed=1;
END $$;

CREATE FUNCTION app.project_workspace_purge_started(
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
  INSERT INTO app.workspace_purge_steps(job_id,step_name) VALUES (v_job.id,'tenant_rows')
    ON CONFLICT DO NOTHING;
  UPDATE app.workspace_purge_jobs SET status='purging',control_sequence=p_sequence,
    control_record_hash=p_record_hash,lease_owner=NULL,lease_token=NULL,
    lease_acquired_at=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
  WHERE id=v_job.id;
  RETURN v_projected;
END $$;

CREATE FUNCTION app.claim_workspace_purge_step(
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
  RETURN QUERY WITH claimed AS (
    UPDATE app.workspace_purge_steps step SET status='running',
      attempt_count=step.attempt_count+1,lease_owner=btrim(p_lease_owner),
      lease_token=gen_random_uuid(),lease_fence=step.lease_fence+1,
      lease_acquired_at=v_now,lease_expires_at=v_now+p_lease_interval,updated_at=v_now
    WHERE step.job_id=v_job.id AND (step.status='pending'
      OR (step.status='running' AND step.lease_expires_at<=v_now))
    RETURNING step.*
  ) SELECT claimed.step_name,claimed.lease_token,claimed.lease_fence FROM claimed;
END $$;

CREATE FUNCTION app.block_incomplete_workspace_deletion()
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
        AND NOT EXISTS (SELECT 1 FROM app.workspace_purge_steps incomplete
          WHERE incomplete.job_id=job.id AND incomplete.status<>'completed')
    ) THEN
    RAISE EXCEPTION 'workspace purge is incomplete' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workspaces_incomplete_deletion_guard
  BEFORE UPDATE ON app.workspaces FOR EACH ROW
  EXECUTE FUNCTION app.block_incomplete_workspace_deletion();

REVOKE ALL ON app.workspace_purge_jobs,app.workspace_purge_steps
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},
    {{lifecycle_command_role}},{{maintenance_role}};
REVOKE ALL ON FUNCTION app.reject_workspace_purge_direct_mutation(),
  app.find_due_workspace_purge(),
  app.workspace_purge_repair_command_id(uuid),
  app.prepare_workspace_purge_job(uuid,bigint,char,varchar,interval),
  app.release_workspace_purge_job(uuid,uuid,bigint),
  app.project_workspace_purge_started(uuid,uuid,bigint,bigint,char,char),
  app.claim_workspace_purge_step(uuid,bigint,char,varchar,interval),
  app.block_incomplete_workspace_deletion() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.find_due_workspace_purge(),
  app.workspace_purge_repair_command_id(uuid),
  app.prepare_workspace_purge_job(uuid,bigint,char,varchar,interval),
  app.release_workspace_purge_job(uuid,uuid,bigint),
  app.project_workspace_purge_started(uuid,uuid,bigint,bigint,char,char),
  app.claim_workspace_purge_step(uuid,bigint,char,varchar,interval)
  TO {{maintenance_role}};
