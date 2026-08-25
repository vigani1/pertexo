CREATE TABLE app.workspace_execution_entitlement_versions (
  workspace_id uuid NOT NULL,
  version integer NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'active',
  active_run_limit integer NOT NULL,
  queued_run_limit integer NOT NULL,
  effective_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, version),
  CONSTRAINT workspace_execution_entitlement_versions_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  CONSTRAINT workspace_execution_entitlement_versions_version_positive CHECK (version > 0),
  CONSTRAINT workspace_execution_entitlement_versions_status_valid CHECK (status IN ('active','suspended')),
  CONSTRAINT workspace_execution_entitlement_versions_limits_valid CHECK (
    active_run_limit BETWEEN 1 AND 10000 AND queued_run_limit BETWEEN 1 AND 100000
  ),
  CONSTRAINT workspace_execution_entitlement_versions_time_valid CHECK (
    expires_at IS NULL OR expires_at > effective_at
  )
);

CREATE TABLE app.workspace_execution_entitlements (
  workspace_id uuid PRIMARY KEY,
  current_version integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT workspace_execution_entitlements_version_fk
    FOREIGN KEY (workspace_id, current_version)
    REFERENCES app.workspace_execution_entitlement_versions(workspace_id, version)
    ON DELETE RESTRICT
);

CREATE TABLE app.workspace_execution_admission_counters (
  workspace_id uuid PRIMARY KEY,
  queued_runs integer NOT NULL DEFAULT 0,
  active_runs integer NOT NULL DEFAULT 0,
  reconciled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT workspace_execution_admission_counters_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  CONSTRAINT workspace_execution_admission_counters_nonnegative CHECK (
    queued_runs >= 0 AND active_runs >= 0
  )
);

CREATE TABLE app.workflow_run_active_admissions (
  workspace_id uuid NOT NULL,
  workflow_run_id uuid PRIMARY KEY,
  outbox_event_id uuid NOT NULL UNIQUE,
  recover_after timestamptz,
  recovery_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT workflow_run_active_admissions_recovery_count_valid
    CHECK (recovery_count BETWEEN 0 AND 1000),
  CONSTRAINT workflow_run_active_admissions_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  CONSTRAINT workflow_run_active_admissions_run_fk
    FOREIGN KEY (workflow_run_id) REFERENCES app.workflow_runs(id) ON DELETE CASCADE,
  CONSTRAINT workflow_run_active_admissions_outbox_fk
    FOREIGN KEY (outbox_event_id) REFERENCES app.outbox_events(id) ON DELETE CASCADE
);

INSERT INTO app.workspace_execution_entitlement_versions (
  workspace_id, version, status, active_run_limit, queued_run_limit, effective_at
)
SELECT id, 1, 'active', 5, 100, '-infinity'::timestamptz FROM app.workspaces;

INSERT INTO app.workspace_execution_entitlements (workspace_id, current_version)
SELECT id, 1 FROM app.workspaces;

INSERT INTO app.workspace_execution_admission_counters (
  workspace_id, queued_runs, active_runs
)
SELECT workspace.id,
       count(run.id) FILTER (WHERE run.status='queued')::integer,
       count(run.id) FILTER (WHERE run.status IN ('running','waiting'))::integer
FROM app.workspaces workspace
LEFT JOIN app.workflow_runs run ON run.workspace_id=workspace.id
GROUP BY workspace.id;

ALTER TABLE app.workflow_runs
  ADD COLUMN execution_entitlement_version integer,
  ADD CONSTRAINT workflow_runs_execution_entitlement_fk
    FOREIGN KEY (workspace_id, execution_entitlement_version)
    REFERENCES app.workspace_execution_entitlement_versions(workspace_id, version)
    ON DELETE RESTRICT NOT VALID;

UPDATE app.workflow_runs run SET execution_entitlement_version=1
WHERE execution_entitlement_version IS NULL
  AND EXISTS (SELECT 1 FROM app.workspaces workspace WHERE workspace.id=run.workspace_id);

CREATE INDEX workspace_execution_entitlement_versions_workspace_time_idx
  ON app.workspace_execution_entitlement_versions(workspace_id, effective_at DESC, version DESC);

CREATE FUNCTION app.reject_execution_entitlement_version_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'workspace execution entitlement versions are immutable' USING ERRCODE='55000';
END $$;
CREATE TRIGGER workspace_execution_entitlement_versions_immutable
  BEFORE UPDATE OR DELETE ON app.workspace_execution_entitlement_versions
  FOR EACH ROW EXECUTE FUNCTION app.reject_execution_entitlement_version_mutation();

CREATE FUNCTION app.provision_workspace_execution_admission()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app SET row_security=on AS $$
DECLARE prior_workspace text;
BEGIN
  prior_workspace := current_setting('app.workspace_id',true);
  PERFORM set_config('app.workspace_id',NEW.id::text,true);
  INSERT INTO app.workspace_execution_entitlement_versions (
    workspace_id,version,status,active_run_limit,queued_run_limit,effective_at
  ) VALUES (NEW.id,1,'active',5,100,'-infinity'::timestamptz);
  INSERT INTO app.workspace_execution_entitlements(workspace_id,current_version)
    VALUES (NEW.id,1);
  INSERT INTO app.workspace_execution_admission_counters(workspace_id)
    VALUES (NEW.id);
  PERFORM set_config('app.workspace_id',coalesce(prior_workspace,''),true);
  RETURN NEW;
END $$;
CREATE TRIGGER workspaces_provision_execution_admission
  AFTER INSERT ON app.workspaces FOR EACH ROW
  EXECUTE FUNCTION app.provision_workspace_execution_admission();

CREATE FUNCTION app.enforce_workflow_run_admission()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app SET row_security=on AS $$
DECLARE
  entitlement record;
  actual_queued integer;
  actual_active integer;
  reserved_active integer;
  next_queued integer;
  next_active integer;
  workspace_status text;
BEGIN
  SELECT status INTO workspace_status FROM app.workspaces
   WHERE id=NEW.workspace_id FOR SHARE;
  IF TG_OP='INSERT' THEN
    SELECT version.version,version.status,version.active_run_limit,
           version.queued_run_limit,version.effective_at,version.expires_at
      INTO entitlement
      FROM app.workspace_execution_entitlements current
      JOIN app.workspace_execution_entitlement_versions version
        ON version.workspace_id=current.workspace_id
       AND version.version=current.current_version
     WHERE current.workspace_id=NEW.workspace_id
     FOR SHARE OF current,version;
  ELSE
    SELECT version.version,version.status,version.active_run_limit,
           version.queued_run_limit,version.effective_at,version.expires_at
      INTO entitlement
      FROM app.workspace_execution_entitlement_versions version
     WHERE version.workspace_id=OLD.workspace_id
       AND version.version=OLD.execution_entitlement_version
     FOR SHARE OF version;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace.run_admission_denied' USING ERRCODE='PTA01';
  END IF;
  IF TG_OP='INSERT' AND (
       entitlement.status <> 'active'
       OR entitlement.effective_at > clock_timestamp()
       OR (entitlement.expires_at IS NOT NULL AND entitlement.expires_at <= clock_timestamp())
       OR workspace_status IS DISTINCT FROM 'active'
     ) THEN
    RAISE EXCEPTION 'workspace.run_admission_denied' USING ERRCODE='PTA01';
  END IF;
  IF TG_OP='UPDATE' AND OLD.status='queued'
     AND NEW.status IN ('running','waiting')
     AND workspace_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'workspace.run_admission_denied' USING ERRCODE='PTA01';
  END IF;

  PERFORM 1 FROM app.workspace_execution_admission_counters
   WHERE workspace_id=NEW.workspace_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace.run_admission_denied' USING ERRCODE='PTA01';
  END IF;

  SELECT count(*) FILTER (WHERE status='queued')::integer,
         count(*) FILTER (WHERE status IN ('running','waiting'))::integer
    INTO actual_queued,actual_active
    FROM app.workflow_runs WHERE workspace_id=NEW.workspace_id;
  IF TG_OP='INSERT' THEN
    SELECT count(*)::integer INTO reserved_active
      FROM app.workflow_run_active_admissions admission
     WHERE admission.workspace_id=NEW.workspace_id;
  ELSE
    SELECT count(*)::integer INTO reserved_active
      FROM app.workflow_run_active_admissions admission
     WHERE admission.workspace_id=NEW.workspace_id
       AND admission.workflow_run_id<>OLD.id;
  END IF;
  next_queued := actual_queued;
  next_active := actual_active + reserved_active;

  IF TG_OP='INSERT' THEN
    NEW.execution_entitlement_version := entitlement.version;
    IF NEW.status='queued' THEN next_queued := next_queued + 1;
    ELSIF NEW.status IN ('running','waiting') THEN next_active := next_active + 1;
    END IF;
  ELSE
    IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR
       NEW.execution_entitlement_version IS DISTINCT FROM OLD.execution_entitlement_version THEN
      RAISE EXCEPTION 'workflow run admission identity is immutable' USING ERRCODE='55000';
    END IF;
    IF OLD.status='queued' THEN next_queued := next_queued - 1;
    ELSIF OLD.status IN ('running','waiting') THEN next_active := next_active - 1;
    END IF;
    IF NEW.status='queued' THEN next_queued := next_queued + 1;
    ELSIF NEW.status IN ('running','waiting') THEN next_active := next_active + 1;
    END IF;
  END IF;

  IF ((TG_OP='INSERT' AND NEW.status='queued') OR
      (TG_OP='UPDATE' AND OLD.status<>'queued' AND NEW.status='queued')) AND
     next_queued > entitlement.queued_run_limit THEN
    RAISE EXCEPTION 'workspace.queued_run_limit_exceeded' USING ERRCODE='PTA02';
  END IF;
  IF ((TG_OP='INSERT' AND NEW.status IN ('running','waiting')) OR
      (TG_OP='UPDATE' AND OLD.status NOT IN ('running','waiting')
       AND NEW.status IN ('running','waiting'))) AND
     next_active > entitlement.active_run_limit THEN
    RAISE EXCEPTION 'workspace.active_run_limit_exceeded' USING ERRCODE='PTA03';
  END IF;

  RETURN NEW;
END $$;
CREATE TRIGGER workflow_runs_execution_admission
  BEFORE INSERT OR UPDATE OF workspace_id,status,execution_entitlement_version
  ON app.workflow_runs FOR EACH ROW EXECUTE FUNCTION app.enforce_workflow_run_admission();

CREATE FUNCTION app.refresh_workflow_run_admission_counters()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app SET row_security=on AS $$
BEGIN
  IF NEW.status<>'queued' THEN
    DELETE FROM app.workflow_run_active_admissions
     WHERE workspace_id=NEW.workspace_id AND workflow_run_id=NEW.id;
  END IF;
  UPDATE app.workspace_execution_admission_counters counter
     SET queued_runs=(SELECT count(*)::integer FROM app.workflow_runs
                       WHERE workspace_id=NEW.workspace_id AND status='queued'),
         active_runs=(SELECT count(*)::integer FROM app.workflow_runs
                       WHERE workspace_id=NEW.workspace_id
                         AND status IN ('running','waiting')),
         reconciled_at=clock_timestamp()
   WHERE counter.workspace_id=NEW.workspace_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace admission state missing' USING ERRCODE='PTA01';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workflow_runs_refresh_execution_admission
  AFTER INSERT OR UPDATE OF workspace_id,status,execution_entitlement_version
  ON app.workflow_runs FOR EACH ROW
  EXECUTE FUNCTION app.refresh_workflow_run_admission_counters();

CREATE FUNCTION app.reconcile_workspace_execution_admission(p_workspace_id uuid)
RETURNS TABLE(queued_runs integer,active_runs integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app SET row_security=on AS $$
BEGIN
  IF nullif(current_setting('app.workspace_id',true),'')::uuid IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'workspace context mismatch' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM app.workspace_execution_admission_counters
   WHERE workspace_id=p_workspace_id FOR UPDATE;
  UPDATE app.workspace_execution_admission_counters counter
     SET queued_runs=(SELECT count(*)::integer FROM app.workflow_runs
                       WHERE workspace_id=p_workspace_id AND status='queued'),
         active_runs=(SELECT count(*)::integer FROM app.workflow_runs
                       WHERE workspace_id=p_workspace_id AND status IN ('running','waiting')),
         reconciled_at=clock_timestamp()
   WHERE counter.workspace_id=p_workspace_id
   RETURNING counter.queued_runs,counter.active_runs INTO queued_runs,active_runs;
  IF NOT FOUND THEN RAISE EXCEPTION 'workspace admission state missing' USING ERRCODE='PTA01'; END IF;
  RETURN NEXT;
END $$;

CREATE FUNCTION app.workflow_run_active_capacity_available(
  p_workspace_id uuid,
  p_entitlement_version integer,
  p_workflow_run_id uuid
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app SET row_security=on AS $$
DECLARE
  active_limit integer;
  active_count integer;
  reserved_count integer;
  workspace_status text;
BEGIN
  IF nullif(current_setting('app.workspace_id',true),'')::uuid IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'workspace context mismatch' USING ERRCODE='42501';
  END IF;
  SELECT version.active_run_limit,
         (SELECT count(*)::integer FROM app.workflow_runs run
           WHERE run.workspace_id=p_workspace_id
             AND run.status IN ('running','waiting'))
    INTO active_limit,active_count
    FROM app.workspace_execution_admission_counters counter
    JOIN app.workspace_execution_entitlement_versions version
      ON version.workspace_id=counter.workspace_id
     AND version.version=p_entitlement_version
   WHERE counter.workspace_id=p_workspace_id
   FOR UPDATE OF counter;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace admission state missing' USING ERRCODE='PTA01';
  END IF;
  SELECT count(*)::integer INTO reserved_count
    FROM app.workflow_run_active_admissions admission
   WHERE admission.workspace_id=p_workspace_id
     AND admission.workflow_run_id<>p_workflow_run_id;
  SELECT status INTO workspace_status FROM app.workspaces
   WHERE id=p_workspace_id;
  RETURN workspace_status='active' AND active_count + reserved_count < active_limit;
END $$;

CREATE FUNCTION app.workflow_run_active_admission_eligible(
  p_workspace_id uuid,
  p_outbox_event_id uuid,
  p_workflow_run_id uuid
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app SET row_security=on AS $$
DECLARE
  active_limit integer;
  active_count integer;
  entitlement_version integer;
  prior_workspace text;
  reserved_count integer;
  result boolean := false;
  run_status text;
  workspace_status text;
BEGIN
  prior_workspace := current_setting('app.workspace_id',true);
  PERFORM set_config('app.workspace_id',p_workspace_id::text,true);
  SELECT run.status,run.execution_entitlement_version,workspace.status
    INTO run_status,entitlement_version,workspace_status
    FROM app.workflow_runs run
    JOIN app.workspaces workspace ON workspace.id=run.workspace_id
    JOIN app.outbox_events event
      ON event.id=p_outbox_event_id
     AND event.workspace_id=run.workspace_id
     AND event.aggregate_type='workflow-run'
     AND event.aggregate_id=run.id
     AND event.job_name='advance-workflow-run'
   WHERE run.workspace_id=p_workspace_id AND run.id=p_workflow_run_id;
  IF NOT FOUND THEN
    result := false;
  ELSIF run_status<>'queued' THEN
    result := true;
  ELSIF workspace_status<>'active' THEN
    result := false;
  ELSIF EXISTS (
    SELECT 1 FROM app.workflow_run_active_admissions
     WHERE workspace_id=p_workspace_id AND workflow_run_id=p_workflow_run_id
       AND outbox_event_id=p_outbox_event_id
  ) THEN
    result := true;
  ELSIF NOT EXISTS (
    SELECT 1 FROM app.workflow_run_active_admissions
     WHERE workspace_id=p_workspace_id AND workflow_run_id=p_workflow_run_id
  ) THEN
    SELECT version.active_run_limit,
           (SELECT count(*)::integer FROM app.workflow_runs active_run
             WHERE active_run.workspace_id=p_workspace_id
               AND active_run.status IN ('running','waiting')),
           (SELECT count(*)::integer FROM app.workflow_run_active_admissions admission
             WHERE admission.workspace_id=p_workspace_id)
      INTO active_limit,active_count,reserved_count
      FROM app.workspace_execution_admission_counters counter
      JOIN app.workspace_execution_entitlement_versions version
        ON version.workspace_id=counter.workspace_id
       AND version.version=entitlement_version
     WHERE counter.workspace_id=p_workspace_id;
    result := FOUND AND active_count + reserved_count < active_limit;
  END IF;
  PERFORM set_config('app.workspace_id',coalesce(prior_workspace,''),true);
  RETURN result;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(prior_workspace,''),true);
  RAISE;
END $$;

CREATE FUNCTION app.reserve_workflow_run_active_admission(
  p_workspace_id uuid,
  p_outbox_event_id uuid,
  p_workflow_run_id uuid
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app SET row_security=on AS $$
DECLARE
  active_limit integer;
  active_count integer;
  entitlement_version integer;
  prior_workspace text;
  reserved_count integer;
  result boolean := false;
  run_status text;
  workspace_status text;
BEGIN
  prior_workspace := current_setting('app.workspace_id',true);
  PERFORM set_config('app.workspace_id',p_workspace_id::text,true);
  SELECT run.status,run.execution_entitlement_version,workspace.status
    INTO run_status,entitlement_version,workspace_status
    FROM app.workflow_runs run
    JOIN app.workspaces workspace ON workspace.id=run.workspace_id
    JOIN app.outbox_events event
      ON event.id=p_outbox_event_id
     AND event.workspace_id=run.workspace_id
     AND event.aggregate_type='workflow-run'
     AND event.aggregate_id=run.id
     AND event.job_name='advance-workflow-run'
   WHERE run.workspace_id=p_workspace_id AND run.id=p_workflow_run_id;
  IF NOT FOUND THEN
    result := false;
  ELSIF run_status<>'queued' THEN
    result := true;
  ELSIF workspace_status<>'active' THEN
    result := false;
  ELSIF EXISTS (
    SELECT 1 FROM app.workflow_run_active_admissions
     WHERE workspace_id=p_workspace_id AND workflow_run_id=p_workflow_run_id
       AND outbox_event_id=p_outbox_event_id
  ) THEN
    result := true;
  ELSIF EXISTS (
    SELECT 1 FROM app.workflow_run_active_admissions
     WHERE workspace_id=p_workspace_id AND workflow_run_id=p_workflow_run_id
  ) THEN
    result := false;
  ELSE
    SELECT version.active_run_limit,
           (SELECT count(*)::integer FROM app.workflow_runs active_run
             WHERE active_run.workspace_id=p_workspace_id
               AND active_run.status IN ('running','waiting')),
           (SELECT count(*)::integer FROM app.workflow_run_active_admissions admission
             WHERE admission.workspace_id=p_workspace_id)
      INTO active_limit,active_count,reserved_count
      FROM app.workspace_execution_admission_counters counter
      JOIN app.workspace_execution_entitlement_versions version
        ON version.workspace_id=counter.workspace_id
       AND version.version=entitlement_version
     WHERE counter.workspace_id=p_workspace_id
     FOR UPDATE OF counter;
    IF FOUND AND active_count + reserved_count < active_limit THEN
      INSERT INTO app.workflow_run_active_admissions(
        workspace_id,workflow_run_id,outbox_event_id
      ) VALUES (p_workspace_id,p_workflow_run_id,p_outbox_event_id);
      result := true;
    END IF;
  END IF;
  PERFORM set_config('app.workspace_id',coalesce(prior_workspace,''),true);
  RETURN result;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(prior_workspace,''),true);
  RAISE;
END $$;

CREATE FUNCTION app.release_workflow_run_active_admission(
  p_workspace_id uuid,
  p_outbox_event_id uuid
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app SET row_security=on AS $$
BEGIN
  IF nullif(current_setting('app.workspace_id',true),'')::uuid IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'workspace context mismatch' USING ERRCODE='42501';
  END IF;
  DELETE FROM app.workflow_run_active_admissions
   WHERE workspace_id=p_workspace_id AND outbox_event_id=p_outbox_event_id;
  RETURN FOUND;
END $$;

CREATE FUNCTION app.release_dispatcher_workflow_run_active_admission(
  p_workspace_id uuid,
  p_outbox_event_id uuid
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app SET row_security=on AS $$
BEGIN
  DELETE FROM app.workflow_run_active_admissions
   WHERE workspace_id=p_workspace_id AND outbox_event_id=p_outbox_event_id;
  RETURN FOUND;
END $$;

CREATE FUNCTION app.arm_dispatcher_workflow_run_active_admission(
  p_workspace_id uuid,
  p_outbox_event_id uuid
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app SET row_security=on AS $$
BEGIN
  UPDATE app.workflow_run_active_admissions
     SET recover_after=clock_timestamp()+interval '5 minutes'
   WHERE workspace_id=p_workspace_id AND outbox_event_id=p_outbox_event_id;
  RETURN FOUND;
END $$;

CREATE FUNCTION app.recover_due_workflow_run_active_admissions(p_limit integer)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app SET row_security=on AS $$
DECLARE
  admission record;
  prior_workspace text;
  recovered integer := 0;
BEGIN
  IF p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'invalid active admission recovery limit' USING ERRCODE='22023';
  END IF;
  prior_workspace := current_setting('app.workspace_id',true);
  FOR admission IN
    SELECT active.workspace_id,active.workflow_run_id,active.outbox_event_id
      FROM app.workflow_run_active_admissions active
     WHERE active.recover_after<=clock_timestamp()
       AND active.recovery_count<1000
     ORDER BY active.recover_after,active.outbox_event_id
     FOR UPDATE OF active SKIP LOCKED
     LIMIT p_limit
  LOOP
    PERFORM set_config('app.workspace_id',admission.workspace_id::text,true);
    PERFORM 1 FROM app.workflow_runs
     WHERE workspace_id=admission.workspace_id
       AND id=admission.workflow_run_id AND status='queued';
    IF NOT FOUND THEN CONTINUE; END IF;
    UPDATE app.outbox_events
       SET published_at=null,available_at=clock_timestamp(),
           last_error_code='publish.delivery_recovery',updated_at=clock_timestamp()
     WHERE workspace_id=admission.workspace_id
       AND id=admission.outbox_event_id
       AND published_at is not null AND failed_at is null;
    IF FOUND THEN
      UPDATE app.workflow_run_active_admissions
         SET recover_after=null,recovery_count=recovery_count+1
       WHERE workflow_run_id=admission.workflow_run_id;
      recovered := recovered+1;
    END IF;
  END LOOP;
  PERFORM set_config('app.workspace_id',coalesce(prior_workspace,''),true);
  RETURN recovered;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(prior_workspace,''),true);
  RAISE;
END $$;

CREATE TABLE app.outbox_fair_dispatch_cursor (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  last_workspace_id uuid,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO app.outbox_fair_dispatch_cursor(singleton) VALUES(true);

ALTER TABLE app.workspace_execution_entitlement_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workspace_execution_entitlement_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE app.workspace_execution_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workspace_execution_entitlements FORCE ROW LEVEL SECURITY;
ALTER TABLE app.workspace_execution_admission_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workspace_execution_admission_counters FORCE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_run_active_admissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_run_active_admissions FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_execution_entitlement_versions_scope
  ON app.workspace_execution_entitlement_versions FOR ALL
  TO {{owner_role}},{{api_runtime_role}},{{worker_runtime_role}}
  USING(workspace_id::text=nullif(current_setting('app.workspace_id',true),''))
  WITH CHECK(workspace_id::text=nullif(current_setting('app.workspace_id',true),''));
CREATE POLICY workspace_execution_entitlements_scope
  ON app.workspace_execution_entitlements FOR ALL
  TO {{owner_role}},{{api_runtime_role}},{{worker_runtime_role}}
  USING(workspace_id::text=nullif(current_setting('app.workspace_id',true),''))
  WITH CHECK(workspace_id::text=nullif(current_setting('app.workspace_id',true),''));
CREATE POLICY workspace_execution_admission_counters_scope
  ON app.workspace_execution_admission_counters FOR ALL
  TO {{owner_role}},{{api_runtime_role}},{{worker_runtime_role}}
  USING(workspace_id::text=nullif(current_setting('app.workspace_id',true),''))
  WITH CHECK(workspace_id::text=nullif(current_setting('app.workspace_id',true),''));
CREATE POLICY workflow_run_active_admissions_owner
  ON app.workflow_run_active_admissions FOR ALL TO {{owner_role}}
  USING(true) WITH CHECK(true);
CREATE POLICY outbox_events_active_admission_owner_select
  ON app.outbox_events FOR SELECT TO {{owner_role}}
  USING(workspace_id::text=nullif(current_setting('app.workspace_id',true),''));
CREATE POLICY outbox_events_active_admission_owner_update
  ON app.outbox_events FOR UPDATE TO {{owner_role}}
  USING(workspace_id::text=nullif(current_setting('app.workspace_id',true),''))
  WITH CHECK(workspace_id::text=nullif(current_setting('app.workspace_id',true),''));

REVOKE ALL ON app.workspace_execution_entitlement_versions,
  app.workspace_execution_entitlements,app.workspace_execution_admission_counters,
  app.workflow_run_active_admissions,
  app.outbox_fair_dispatch_cursor
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}};
GRANT SELECT ON app.workspace_execution_entitlement_versions,
  app.workspace_execution_entitlements,app.workspace_execution_admission_counters
  TO {{api_runtime_role}},{{worker_runtime_role}};
REVOKE ALL ON FUNCTION app.reconcile_workspace_execution_admission(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reconcile_workspace_execution_admission(uuid)
  TO {{api_runtime_role}},{{worker_runtime_role}};
REVOKE ALL ON FUNCTION app.workflow_run_active_capacity_available(uuid,integer,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.workflow_run_active_capacity_available(uuid,integer,uuid)
  TO {{worker_runtime_role}};
REVOKE ALL ON FUNCTION app.reserve_workflow_run_active_admission(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reserve_workflow_run_active_admission(uuid,uuid,uuid)
  TO {{dispatcher_role}};
REVOKE ALL ON FUNCTION app.workflow_run_active_admission_eligible(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.workflow_run_active_admission_eligible(uuid,uuid,uuid)
  TO {{dispatcher_role}};
REVOKE ALL ON FUNCTION app.release_workflow_run_active_admission(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.release_workflow_run_active_admission(uuid,uuid)
  TO {{worker_runtime_role}};
REVOKE ALL ON FUNCTION app.release_dispatcher_workflow_run_active_admission(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.release_dispatcher_workflow_run_active_admission(uuid,uuid)
  TO {{dispatcher_role}};
REVOKE ALL ON FUNCTION app.arm_dispatcher_workflow_run_active_admission(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.arm_dispatcher_workflow_run_active_admission(uuid,uuid)
  TO {{dispatcher_role}};
REVOKE ALL ON FUNCTION app.recover_due_workflow_run_active_admissions(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recover_due_workflow_run_active_admissions(integer)
  TO {{dispatcher_role}};
GRANT SELECT,UPDATE(last_workspace_id,updated_at)
  ON app.outbox_fair_dispatch_cursor TO {{dispatcher_role}};
