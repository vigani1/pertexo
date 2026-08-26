-- ADR 013/027 crash-repairable deletion completion and minimized tombstone.

CREATE TABLE app.workspace_purge_completions (
  job_id uuid PRIMARY KEY REFERENCES app.workspace_purge_jobs(id) ON DELETE RESTRICT,
  command_id uuid NOT NULL UNIQUE,
  actor_ref varchar(128) NOT NULL DEFAULT 'maintenance:workspace-purge',
  reason varchar(512) NOT NULL DEFAULT 'Workspace purge completed',
  occurred_at timestamptz NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'ready',
  attempt_count integer NOT NULL DEFAULT 0,
  lease_owner varchar(128),
  lease_token uuid,
  lease_fence bigint NOT NULL DEFAULT 0,
  lease_acquired_at timestamptz,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  projected_at timestamptz,
  CONSTRAINT workspace_purge_completions_status_valid
    CHECK (status IN ('ready','running','projected')),
  CONSTRAINT workspace_purge_completions_material_valid CHECK (
    actor_ref='maintenance:workspace-purge'
    AND reason='Workspace purge completed'
  ),
  CONSTRAINT workspace_purge_completions_attempt_nonnegative CHECK (attempt_count>=0),
  CONSTRAINT workspace_purge_completions_fence_nonnegative CHECK (lease_fence>=0),
  CONSTRAINT workspace_purge_completions_lease_valid CHECK (
    (lease_owner IS NULL AND lease_token IS NULL AND lease_acquired_at IS NULL
      AND lease_expires_at IS NULL)
    OR (status='running' AND length(btrim(lease_owner)) BETWEEN 1 AND 128
      AND lease_token IS NOT NULL AND lease_acquired_at IS NOT NULL
      AND lease_expires_at>lease_acquired_at
      AND lease_expires_at<=lease_acquired_at+interval '5 minutes')
  ),
  CONSTRAINT workspace_purge_completions_projection_valid CHECK (
    (status IN ('ready','running') AND projected_at IS NULL)
    OR (status='projected' AND projected_at IS NOT NULL)
  )
);
ALTER TABLE app.workspace_purge_completions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workspace_purge_completions FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_purge_completions_owner_all
  ON app.workspace_purge_completions FOR ALL TO {{owner_role}}
  USING (true) WITH CHECK (true);

CREATE TRIGGER workspace_purge_completions_controlled_mutation
  BEFORE UPDATE OR DELETE ON app.workspace_purge_completions FOR EACH ROW
  EXECUTE FUNCTION app.reject_workspace_purge_direct_mutation();

CREATE FUNCTION app.find_due_workspace_purge_completion()
RETURNS TABLE(job_id uuid,workspace_id uuid) LANGUAGE sql SECURITY DEFINER STABLE
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
  SELECT job.id,job.workspace_id FROM app.workspace_purge_jobs job
  LEFT JOIN app.workspace_purge_completions completion ON completion.job_id=job.id
  WHERE job.status='purging'
    AND EXISTS (SELECT 1 FROM app.workspace_purge_steps step
      WHERE step.job_id=job.id AND step.step_name='object_versions'
        AND step.status='completed')
    AND EXISTS (SELECT 1 FROM app.workspace_purge_steps step
      WHERE step.job_id=job.id AND step.step_name='tenant_rows'
        AND step.status='completed')
    AND NOT EXISTS (SELECT 1 FROM app.workspace_purge_steps step
      WHERE step.job_id=job.id AND step.status<>'completed')
    AND (completion.job_id IS NULL OR completion.status='ready'
      OR (completion.status='running' AND completion.lease_expires_at<=clock_timestamp()))
    AND NOT EXISTS (SELECT 1 FROM app.workspace_legal_holds hold
      WHERE hold.workspace_id=job.workspace_id AND hold.released_sequence IS NULL)
  ORDER BY coalesce(completion.updated_at,job.updated_at),job.id LIMIT 1
$$;

CREATE FUNCTION app.workspace_purge_completion_repair_command_id(p_workspace_id uuid)
RETURNS uuid LANGUAGE sql SECURITY DEFINER STABLE
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
  SELECT completion.command_id FROM app.workspace_purge_jobs job
  JOIN app.workspace_purge_completions completion ON completion.job_id=job.id
  WHERE job.workspace_id=p_workspace_id AND job.status='purging'
$$;

CREATE FUNCTION app.prepare_workspace_purge_completion(
  p_job_id uuid,p_projected_sequence bigint,p_projected_hash char(64),
  p_lease_owner varchar,p_lease_interval interval
) RETURNS TABLE(command_id uuid,actor_ref varchar,reason varchar,occurred_at timestamptz,
  lease_token uuid,lease_fence bigint) LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_job app.workspace_purge_jobs%ROWTYPE;
DECLARE v_now timestamptz:=date_trunc('milliseconds',clock_timestamp());
BEGIN
  IF p_job_id IS NULL OR p_projected_sequence IS NULL OR p_projected_sequence<1
    OR p_projected_hash IS NULL OR p_projected_hash!~'^[0-9a-f]{64}$'
    OR p_lease_owner IS NULL OR length(btrim(p_lease_owner)) NOT BETWEEN 1 AND 128
    OR p_lease_interval IS NULL OR p_lease_interval<=interval '0 seconds'
    OR p_lease_interval>interval '5 minutes' THEN
    RAISE EXCEPTION 'invalid workspace purge completion claim' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_job FROM app.workspace_purge_jobs WHERE id=p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.status<>'purging' THEN
    RAISE EXCEPTION 'workspace purge is not ready for completion' USING ERRCODE='55000';
  END IF;
  PERFORM 1 FROM app.workspaces workspace WHERE workspace.id=v_job.workspace_id
    AND workspace.status='purging'
    AND workspace.retention_control_sequence=p_projected_sequence
    AND workspace.retention_control_hash=p_projected_hash FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace purge completion high water changed' USING ERRCODE='40001';
  END IF;
  IF EXISTS (SELECT 1 FROM app.workspace_purge_steps step
      WHERE step.job_id=v_job.id AND step.status<>'completed')
    OR NOT EXISTS (SELECT 1 FROM app.workspace_purge_steps step
      WHERE step.job_id=v_job.id AND step.step_name='object_versions' AND step.status='completed')
    OR NOT EXISTS (SELECT 1 FROM app.workspace_purge_steps step
      WHERE step.job_id=v_job.id AND step.step_name='tenant_rows' AND step.status='completed') THEN
    RAISE EXCEPTION 'workspace purge steps are incomplete' USING ERRCODE='55000';
  END IF;
  IF EXISTS (SELECT 1 FROM app.workspace_legal_holds hold
      WHERE hold.workspace_id=v_job.workspace_id AND hold.released_sequence IS NULL) THEN
    RAISE EXCEPTION 'active workspace legal hold blocks purge completion'
      USING ERRCODE='55000';
  END IF;
  PERFORM set_config('app.workspace_purge_transition','on',true);
  INSERT INTO app.workspace_purge_completions(job_id,command_id,occurred_at)
    VALUES (v_job.id,gen_random_uuid(),v_now) ON CONFLICT DO NOTHING;
  RETURN QUERY WITH claimed AS (
    UPDATE app.workspace_purge_completions completion SET status='running',
      attempt_count=completion.attempt_count+1,lease_owner=btrim(p_lease_owner),
      lease_token=gen_random_uuid(),lease_fence=completion.lease_fence+1,
      lease_acquired_at=v_now,lease_expires_at=v_now+p_lease_interval,updated_at=v_now
    WHERE completion.job_id=v_job.id AND (completion.status='ready'
      OR (completion.status='running' AND completion.lease_expires_at<=v_now))
    RETURNING completion.*
  ) SELECT claimed.command_id,claimed.actor_ref,claimed.reason,claimed.occurred_at,
      claimed.lease_token,claimed.lease_fence FROM claimed;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace purge completion is not claimable' USING ERRCODE='55P03';
  END IF;
END $$;

CREATE FUNCTION app.release_workspace_purge_completion(
  p_job_id uuid,p_lease_token uuid,p_lease_fence bigint
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_changed integer;
BEGIN
  PERFORM set_config('app.workspace_purge_transition','on',true);
  UPDATE app.workspace_purge_completions SET status='ready',lease_owner=NULL,
    lease_token=NULL,lease_acquired_at=NULL,lease_expires_at=NULL,
    updated_at=clock_timestamp()
  WHERE job_id=p_job_id AND status='running' AND lease_token=p_lease_token
    AND lease_fence=p_lease_fence AND lease_expires_at>clock_timestamp();
  GET DIAGNOSTICS v_changed=ROW_COUNT;
  RETURN v_changed=1;
END $$;

CREATE FUNCTION app.authorize_workspace_purge_completion_append(
  p_job_id uuid,p_lease_token uuid,p_lease_fence bigint,
  p_projected_sequence bigint,p_projected_hash char(64)
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_job app.workspace_purge_jobs%ROWTYPE;
DECLARE v_completion app.workspace_purge_completions%ROWTYPE;
BEGIN
  IF p_job_id IS NULL OR p_lease_token IS NULL OR p_lease_fence IS NULL
    OR p_projected_sequence IS NULL OR p_projected_sequence<1
    OR p_projected_hash IS NULL OR p_projected_hash!~'^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid workspace purge completion append authorization'
      USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_job FROM app.workspace_purge_jobs WHERE id=p_job_id;
  SELECT * INTO v_completion FROM app.workspace_purge_completions WHERE job_id=p_job_id;
  IF v_job.id IS NULL OR v_job.status<>'purging' OR v_completion.job_id IS NULL
    OR v_completion.status<>'running'
    OR v_completion.lease_token IS DISTINCT FROM p_lease_token
    OR v_completion.lease_fence IS DISTINCT FROM p_lease_fence
    OR v_completion.lease_expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'workspace purge completion lease is stale' USING ERRCODE='55000';
  END IF;
  PERFORM 1 FROM app.workspaces workspace WHERE workspace.id=v_job.workspace_id
    AND workspace.status='purging'
    AND workspace.retention_control_sequence=p_projected_sequence
    AND workspace.retention_control_hash=p_projected_hash FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace purge completion high water changed' USING ERRCODE='40001';
  END IF;
  IF EXISTS (SELECT 1 FROM app.workspace_purge_steps step
      WHERE step.job_id=v_job.id AND step.status<>'completed')
    OR NOT EXISTS (SELECT 1 FROM app.workspace_purge_steps step
      WHERE step.job_id=v_job.id AND step.step_name='object_versions' AND step.status='completed')
    OR NOT EXISTS (SELECT 1 FROM app.workspace_purge_steps step
      WHERE step.job_id=v_job.id AND step.step_name='tenant_rows' AND step.status='completed') THEN
    RAISE EXCEPTION 'workspace purge steps are incomplete' USING ERRCODE='55000';
  END IF;
  IF EXISTS (SELECT 1 FROM app.workspace_legal_holds hold
      WHERE hold.workspace_id=v_job.workspace_id AND hold.released_sequence IS NULL) THEN
    RAISE EXCEPTION 'active workspace legal hold blocks purge completion append'
      USING ERRCODE='55000';
  END IF;
  RETURN true;
END $$;

ALTER TABLE app.workspaces ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE app.workspaces DROP CONSTRAINT workspaces_deletion_state_valid;
ALTER TABLE app.workspaces ADD CONSTRAINT workspaces_deletion_state_valid CHECK (
  (status IN ('active','suspended') AND created_by IS NOT NULL
    AND deletion_requested_at IS NULL AND deletion_requested_by IS NULL
    AND deletion_reason IS NULL AND purge_after IS NULL)
  OR (status IN ('pending_deletion','purging') AND created_by IS NOT NULL
    AND deletion_requested_at IS NOT NULL AND deletion_requested_by IS NOT NULL
    AND deletion_reason IS NOT NULL AND length(btrim(deletion_reason)) BETWEEN 1 AND 512
    AND purge_after IS NOT NULL AND purge_after>deletion_requested_at)
  OR (status='deleted' AND created_by IS NULL AND deletion_requested_at IS NOT NULL
    AND deletion_requested_by IS NULL AND deletion_reason='purged'
    AND purge_after IS NOT NULL AND purge_after>deletion_requested_at
    AND name='Deleted workspace' AND slug='deleted-'||id::text)
);

CREATE OR REPLACE FUNCTION app.block_incomplete_workspace_deletion()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
BEGIN
  IF NEW.status='deleted' AND OLD.status IS DISTINCT FROM 'deleted' THEN
    IF NOT EXISTS (
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
    NEW.name:='Deleted workspace';
    NEW.slug:='deleted-'||NEW.id::text;
    NEW.created_by:=NULL;
    NEW.deletion_requested_by:=NULL;
    NEW.deletion_reason:='purged';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION app.project_workspace_purge_completion(
  p_job_id uuid,p_lease_token uuid,p_lease_fence bigint,p_sequence bigint,
  p_previous_hash char(64),p_record_hash char(64)
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_job app.workspace_purge_jobs%ROWTYPE;
DECLARE v_completion app.workspace_purge_completions%ROWTYPE;
DECLARE v_projected boolean;
BEGIN
  IF p_job_id IS NULL OR p_lease_token IS NULL OR p_lease_fence IS NULL
    OR p_sequence IS NULL OR p_sequence<1 OR p_previous_hash IS NULL
    OR p_previous_hash!~'^[0-9a-f]{64}$' OR p_record_hash IS NULL
    OR p_record_hash!~'^[0-9a-f]{64}$' OR p_previous_hash=p_record_hash THEN
    RAISE EXCEPTION 'invalid workspace purge completion projection' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_job FROM app.workspace_purge_jobs WHERE id=p_job_id FOR UPDATE;
  SELECT * INTO v_completion FROM app.workspace_purge_completions
    WHERE job_id=p_job_id FOR UPDATE;
  IF v_job.id IS NULL OR v_job.status<>'purging' OR v_completion.job_id IS NULL
    OR v_completion.status<>'running'
    OR v_completion.lease_token IS DISTINCT FROM p_lease_token
    OR v_completion.lease_fence IS DISTINCT FROM p_lease_fence
    OR v_completion.lease_expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'workspace purge completion lease is stale' USING ERRCODE='55000';
  END IF;
  IF EXISTS (SELECT 1 FROM app.workspace_purge_steps step
      WHERE step.job_id=v_job.id AND step.status<>'completed') THEN
    RAISE EXCEPTION 'workspace purge steps are incomplete' USING ERRCODE='55000';
  END IF;
  PERFORM set_config('app.workspace_purge_transition','on',true);
  UPDATE app.workspace_purge_jobs SET status='completed',control_sequence=p_sequence,
    control_record_hash=p_record_hash,completed_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE id=v_job.id;
  v_projected:=app.project_workspace_deletion(v_job.workspace_id,p_sequence,
    v_completion.command_id,'deletion_completed',v_job.workspace_id,p_previous_hash,
    p_record_hash,v_completion.actor_ref,NULL,v_completion.reason,
    v_completion.occurred_at,interval '30 days');
  UPDATE app.workspace_purge_completions SET status='projected',lease_owner=NULL,
    lease_token=NULL,lease_acquired_at=NULL,lease_expires_at=NULL,
    projected_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE job_id=v_job.id;
  RETURN v_projected;
END $$;

REVOKE ALL ON app.workspace_purge_completions
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},
    {{lifecycle_command_role}},{{maintenance_role}};
REVOKE ALL ON FUNCTION app.find_due_workspace_purge_completion(),
  app.workspace_purge_completion_repair_command_id(uuid),
  app.prepare_workspace_purge_completion(uuid,bigint,char,varchar,interval),
  app.release_workspace_purge_completion(uuid,uuid,bigint),
  app.authorize_workspace_purge_completion_append(uuid,uuid,bigint,bigint,char),
  app.project_workspace_purge_completion(uuid,uuid,bigint,bigint,char,char)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},
    {{lifecycle_command_role}};
GRANT EXECUTE ON FUNCTION app.find_due_workspace_purge_completion(),
  app.workspace_purge_completion_repair_command_id(uuid),
  app.prepare_workspace_purge_completion(uuid,bigint,char,varchar,interval),
  app.release_workspace_purge_completion(uuid,uuid,bigint),
  app.authorize_workspace_purge_completion_append(uuid,uuid,bigint,bigint,char),
  app.project_workspace_purge_completion(uuid,uuid,bigint,bigint,char,char)
  TO {{maintenance_role}};
