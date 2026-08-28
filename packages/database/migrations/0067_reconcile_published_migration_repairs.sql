-- Forward-only convergence for corrections that were previously folded into
-- published migrations 0037 and 0038. Every known published checksum reaches
-- the same schema through this migration.

CREATE OR REPLACE FUNCTION app.lock_failure_notification_dispatch_destination(
  p_workspace_id uuid,
  p_intent_id uuid,
  p_attempt_number integer
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app SET row_security=on AS $$
DECLARE
  workspace_active boolean := false;
  destination_enabled boolean := false;
BEGIN
  IF nullif(current_setting('app.workspace_id',true),'')::uuid
       IS DISTINCT FROM p_workspace_id THEN
    RETURN false;
  END IF;
  SELECT true INTO workspace_active
    FROM app.workspaces workspace
   WHERE workspace.id=p_workspace_id AND workspace.status='active'
   FOR SHARE OF workspace;
  IF NOT coalesce(workspace_active,false) THEN RETURN false; END IF;
  SELECT destination.status='enabled' INTO destination_enabled
    FROM app.run_failure_notification_intents intent
    JOIN app.failure_notification_destinations destination
      ON destination.workspace_id=intent.workspace_id
     AND destination.id=intent.destination_id
   WHERE intent.workspace_id=p_workspace_id
     AND intent.id=p_intent_id
     AND intent.status='claimed'
     AND intent.delivery_attempts=p_attempt_number
   FOR SHARE OF destination;
  RETURN coalesce(destination_enabled,false);
END $$;
ALTER FUNCTION app.lock_failure_notification_dispatch_destination(uuid,uuid,integer)
  OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.lock_failure_notification_dispatch_destination(uuid,uuid,integer)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}};
GRANT EXECUTE ON FUNCTION app.lock_failure_notification_dispatch_destination(uuid,uuid,integer)
  TO {{worker_runtime_role}};

DROP POLICY IF EXISTS failure_notification_destinations_workspace_scope
  ON app.failure_notification_destinations;
CREATE POLICY failure_notification_destinations_workspace_scope
  ON app.failure_notification_destinations FOR ALL
  TO {{owner_role}},{{api_runtime_role}},{{worker_runtime_role}}
  USING(workspace_id::text=nullif(current_setting('app.workspace_id',true),''))
  WITH CHECK(workspace_id::text=nullif(current_setting('app.workspace_id',true),''));
DROP POLICY IF EXISTS failure_notification_destination_versions_workspace_scope
  ON app.failure_notification_destination_versions;
CREATE POLICY failure_notification_destination_versions_workspace_scope
  ON app.failure_notification_destination_versions FOR ALL
  TO {{owner_role}},{{api_runtime_role}},{{worker_runtime_role}}
  USING(workspace_id::text=nullif(current_setting('app.workspace_id',true),''))
  WITH CHECK(workspace_id::text=nullif(current_setting('app.workspace_id',true),''));
DROP POLICY IF EXISTS workflow_failure_notification_policies_workspace_scope
  ON app.workflow_failure_notification_policies;
CREATE POLICY workflow_failure_notification_policies_workspace_scope
  ON app.workflow_failure_notification_policies FOR ALL
  TO {{owner_role}},{{api_runtime_role}}
  USING(workspace_id::text=nullif(current_setting('app.workspace_id',true),''))
  WITH CHECK(workspace_id::text=nullif(current_setting('app.workspace_id',true),''));

CREATE TABLE IF NOT EXISTS app.workflow_run_active_admissions (
  workspace_id uuid NOT NULL,
  workflow_run_id uuid PRIMARY KEY,
  outbox_event_id uuid NOT NULL UNIQUE,
  recover_after timestamptz,
  recovery_count bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT workflow_run_active_admissions_recovery_count_valid
    CHECK(recovery_count>=0),
  CONSTRAINT workflow_run_active_admissions_workspace_fk
    FOREIGN KEY(workspace_id) REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  CONSTRAINT workflow_run_active_admissions_run_fk
    FOREIGN KEY(workflow_run_id) REFERENCES app.workflow_runs(id) ON DELETE CASCADE,
  CONSTRAINT workflow_run_active_admissions_outbox_fk
    FOREIGN KEY(outbox_event_id) REFERENCES app.outbox_events(id) ON DELETE CASCADE
);
ALTER TABLE app.workflow_run_active_admissions
  ALTER COLUMN recovery_count TYPE bigint;
ALTER TABLE app.workflow_run_active_admissions
  DROP CONSTRAINT IF EXISTS workflow_run_active_admissions_recovery_count_valid;
ALTER TABLE app.workflow_run_active_admissions
  ADD CONSTRAINT workflow_run_active_admissions_recovery_count_valid
  CHECK(recovery_count>=0);

CREATE OR REPLACE FUNCTION app.enforce_workflow_run_admission()
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
       entitlement.status<>'active'
       OR entitlement.effective_at>clock_timestamp()
       OR (entitlement.expires_at IS NOT NULL AND entitlement.expires_at<=clock_timestamp())
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
  SELECT count(*) FILTER(WHERE status='queued')::integer,
         count(*) FILTER(WHERE status IN ('running','waiting'))::integer
    INTO actual_queued,actual_active
    FROM app.workflow_runs WHERE workspace_id=NEW.workspace_id;
  IF TG_OP='INSERT' THEN
    SELECT count(*)::integer INTO reserved_active
      FROM app.workflow_run_active_admissions
     WHERE workspace_id=NEW.workspace_id;
  ELSE
    SELECT count(*)::integer INTO reserved_active
      FROM app.workflow_run_active_admissions
     WHERE workspace_id=NEW.workspace_id AND workflow_run_id<>OLD.id;
  END IF;
  next_queued:=actual_queued;
  next_active:=actual_active+reserved_active;
  IF TG_OP='INSERT' THEN
    NEW.execution_entitlement_version:=entitlement.version;
    IF NEW.status='queued' THEN next_queued:=next_queued+1;
    ELSIF NEW.status IN ('running','waiting') THEN next_active:=next_active+1;
    END IF;
  ELSE
    IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR
       NEW.execution_entitlement_version IS DISTINCT FROM OLD.execution_entitlement_version THEN
      RAISE EXCEPTION 'workflow run admission identity is immutable' USING ERRCODE='55000';
    END IF;
    IF OLD.status='queued' THEN next_queued:=next_queued-1;
    ELSIF OLD.status IN ('running','waiting') THEN next_active:=next_active-1;
    END IF;
    IF NEW.status='queued' THEN next_queued:=next_queued+1;
    ELSIF NEW.status IN ('running','waiting') THEN next_active:=next_active+1;
    END IF;
  END IF;
  IF ((TG_OP='INSERT' AND NEW.status='queued') OR
      (TG_OP='UPDATE' AND OLD.status<>'queued' AND NEW.status='queued')) AND
     next_queued>entitlement.queued_run_limit THEN
    RAISE EXCEPTION 'workspace.queued_run_limit_exceeded' USING ERRCODE='PTA02';
  END IF;
  IF ((TG_OP='INSERT' AND NEW.status IN ('running','waiting')) OR
      (TG_OP='UPDATE' AND OLD.status NOT IN ('running','waiting')
       AND NEW.status IN ('running','waiting'))) AND
     next_active>entitlement.active_run_limit THEN
    RAISE EXCEPTION 'workspace.active_run_limit_exceeded' USING ERRCODE='PTA03';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app.refresh_workflow_run_admission_counters()
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

DROP FUNCTION IF EXISTS app.workflow_run_active_capacity_available(uuid,integer);
CREATE OR REPLACE FUNCTION app.workflow_run_active_capacity_available(
  p_workspace_id uuid,
  p_entitlement_version integer,
  p_workflow_run_id uuid
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app SET row_security=on AS $$
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
    FROM app.workflow_run_active_admissions
   WHERE workspace_id=p_workspace_id AND workflow_run_id<>p_workflow_run_id;
  SELECT status INTO workspace_status FROM app.workspaces WHERE id=p_workspace_id;
  RETURN workspace_status='active' AND active_count+reserved_count<active_limit;
END $$;

CREATE OR REPLACE FUNCTION app.workflow_run_active_admission_eligible(
  p_workspace_id uuid,
  p_outbox_event_id uuid,
  p_workflow_run_id uuid
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app SET row_security=on AS $$
DECLARE
  active_limit integer;
  active_count integer;
  entitlement_version integer;
  prior_workspace text;
  reserved_count integer;
  result boolean:=false;
  run_status text;
  workspace_status text;
BEGIN
  prior_workspace:=current_setting('app.workspace_id',true);
  PERFORM set_config('app.workspace_id',p_workspace_id::text,true);
  SELECT run.status,run.execution_entitlement_version,workspace.status
    INTO run_status,entitlement_version,workspace_status
    FROM app.workflow_runs run
    JOIN app.workspaces workspace ON workspace.id=run.workspace_id
    JOIN app.outbox_events event
      ON event.id=p_outbox_event_id AND event.workspace_id=run.workspace_id
     AND event.aggregate_type='workflow-run' AND event.aggregate_id=run.id
     AND event.job_name='advance-workflow-run'
   WHERE run.workspace_id=p_workspace_id AND run.id=p_workflow_run_id;
  IF NOT FOUND THEN result:=false;
  ELSIF run_status<>'queued' THEN result:=true;
  ELSIF workspace_status<>'active' THEN result:=false;
  ELSIF EXISTS(
    SELECT 1 FROM app.workflow_run_active_admissions
     WHERE workspace_id=p_workspace_id AND workflow_run_id=p_workflow_run_id
       AND outbox_event_id=p_outbox_event_id
  ) THEN result:=true;
  ELSIF NOT EXISTS(
    SELECT 1 FROM app.workflow_run_active_admissions
     WHERE workspace_id=p_workspace_id AND workflow_run_id=p_workflow_run_id
  ) THEN
    SELECT version.active_run_limit,
           (SELECT count(*)::integer FROM app.workflow_runs active_run
             WHERE active_run.workspace_id=p_workspace_id
               AND active_run.status IN ('running','waiting')),
           (SELECT count(*)::integer FROM app.workflow_run_active_admissions
             WHERE workspace_id=p_workspace_id)
      INTO active_limit,active_count,reserved_count
      FROM app.workspace_execution_admission_counters counter
      JOIN app.workspace_execution_entitlement_versions version
        ON version.workspace_id=counter.workspace_id
       AND version.version=entitlement_version
     WHERE counter.workspace_id=p_workspace_id;
    result:=FOUND AND active_count+reserved_count<active_limit;
  END IF;
  PERFORM set_config('app.workspace_id',coalesce(prior_workspace,''),true);
  RETURN result;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(prior_workspace,''),true);
  RAISE;
END $$;

CREATE OR REPLACE FUNCTION app.reserve_workflow_run_active_admission(
  p_workspace_id uuid,
  p_outbox_event_id uuid,
  p_workflow_run_id uuid
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app SET row_security=on AS $$
DECLARE
  active_limit integer;
  active_count integer;
  entitlement_version integer;
  prior_workspace text;
  reserved_count integer;
  result boolean:=false;
  run_status text;
  workspace_status text;
BEGIN
  prior_workspace:=current_setting('app.workspace_id',true);
  PERFORM set_config('app.workspace_id',p_workspace_id::text,true);
  SELECT run.status,run.execution_entitlement_version,workspace.status
    INTO run_status,entitlement_version,workspace_status
    FROM app.workflow_runs run
    JOIN app.workspaces workspace ON workspace.id=run.workspace_id
    JOIN app.outbox_events event
      ON event.id=p_outbox_event_id AND event.workspace_id=run.workspace_id
     AND event.aggregate_type='workflow-run' AND event.aggregate_id=run.id
     AND event.job_name='advance-workflow-run'
   WHERE run.workspace_id=p_workspace_id AND run.id=p_workflow_run_id;
  IF NOT FOUND THEN result:=false;
  ELSIF run_status<>'queued' THEN result:=true;
  ELSIF workspace_status<>'active' THEN result:=false;
  ELSIF EXISTS(
    SELECT 1 FROM app.workflow_run_active_admissions
     WHERE workspace_id=p_workspace_id AND workflow_run_id=p_workflow_run_id
       AND outbox_event_id=p_outbox_event_id
  ) THEN result:=true;
  ELSIF EXISTS(
    SELECT 1 FROM app.workflow_run_active_admissions
     WHERE workspace_id=p_workspace_id AND workflow_run_id=p_workflow_run_id
  ) THEN result:=false;
  ELSE
    SELECT version.active_run_limit,
           (SELECT count(*)::integer FROM app.workflow_runs active_run
             WHERE active_run.workspace_id=p_workspace_id
               AND active_run.status IN ('running','waiting')),
           (SELECT count(*)::integer FROM app.workflow_run_active_admissions
             WHERE workspace_id=p_workspace_id)
      INTO active_limit,active_count,reserved_count
      FROM app.workspace_execution_admission_counters counter
      JOIN app.workspace_execution_entitlement_versions version
        ON version.workspace_id=counter.workspace_id
       AND version.version=entitlement_version
     WHERE counter.workspace_id=p_workspace_id
     FOR UPDATE OF counter;
    IF FOUND AND active_count+reserved_count<active_limit THEN
      INSERT INTO app.workflow_run_active_admissions(
        workspace_id,workflow_run_id,outbox_event_id
      ) VALUES(p_workspace_id,p_workflow_run_id,p_outbox_event_id);
      result:=true;
    END IF;
  END IF;
  PERFORM set_config('app.workspace_id',coalesce(prior_workspace,''),true);
  RETURN result;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(prior_workspace,''),true);
  RAISE;
END $$;

CREATE OR REPLACE FUNCTION app.release_workflow_run_active_admission(
  p_workspace_id uuid,p_outbox_event_id uuid
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app SET row_security=on AS $$
BEGIN
  IF nullif(current_setting('app.workspace_id',true),'')::uuid IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'workspace context mismatch' USING ERRCODE='42501';
  END IF;
  DELETE FROM app.workflow_run_active_admissions
   WHERE workspace_id=p_workspace_id AND outbox_event_id=p_outbox_event_id;
  RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION app.release_dispatcher_workflow_run_active_admission(
  p_workspace_id uuid,p_outbox_event_id uuid
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app SET row_security=on AS $$
BEGIN
  DELETE FROM app.workflow_run_active_admissions
   WHERE workspace_id=p_workspace_id AND outbox_event_id=p_outbox_event_id;
  RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION app.arm_dispatcher_workflow_run_active_admission(
  p_workspace_id uuid,p_outbox_event_id uuid
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app SET row_security=on AS $$
BEGIN
  UPDATE app.workflow_run_active_admissions
     SET recover_after=clock_timestamp()+interval '5 minutes'
   WHERE workspace_id=p_workspace_id AND outbox_event_id=p_outbox_event_id;
  RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION app.recover_due_workflow_run_active_admissions(p_limit integer)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app SET row_security=on AS $$
DECLARE
  admission record;
  canonical_payload text;
  new_outbox_event_id uuid;
  new_payload jsonb;
  old_payload jsonb;
  prior_workspace text;
  recovered integer:=0;
BEGIN
  IF p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'invalid active admission recovery limit' USING ERRCODE='22023';
  END IF;
  prior_workspace:=current_setting('app.workspace_id',true);
  FOR admission IN
    SELECT active.workspace_id,active.workflow_run_id,active.outbox_event_id
      FROM app.workflow_run_active_admissions active
     WHERE active.recover_after<=clock_timestamp()
     ORDER BY active.recover_after,active.outbox_event_id
     FOR UPDATE OF active SKIP LOCKED LIMIT p_limit
  LOOP
    PERFORM set_config('app.workspace_id',admission.workspace_id::text,true);
    PERFORM 1 FROM app.workflow_runs
     WHERE workspace_id=admission.workspace_id
       AND id=admission.workflow_run_id AND status='queued';
    IF NOT FOUND THEN CONTINUE; END IF;
    SELECT payload INTO old_payload FROM app.outbox_events
     WHERE workspace_id=admission.workspace_id
       AND id=admission.outbox_event_id
       AND published_at IS NOT NULL AND failed_at IS NULL;
    IF FOUND THEN
      new_outbox_event_id:=gen_random_uuid();
      new_payload:=old_payload||jsonb_build_object('outboxEventId',new_outbox_event_id);
      canonical_payload:='{"outboxEventId":"'||new_outbox_event_id::text||
        '","runId":"'||admission.workflow_run_id::text||
        '","schemaVersion":1'||
        CASE WHEN old_payload?'traceparent'
          THEN ',"traceparent":'||to_jsonb(old_payload->>'traceparent')::text
          ELSE '' END||
        ',"workspaceId":"'||admission.workspace_id::text||'"}';
      INSERT INTO app.outbox_events(
        id,workspace_id,job_name,schema_version,aggregate_type,aggregate_id,
        payload,payload_checksum,available_at,last_error_code
      ) VALUES(
        new_outbox_event_id,admission.workspace_id,'advance-workflow-run',1,
        'workflow-run',admission.workflow_run_id,new_payload,
        encode(sha256(convert_to(canonical_payload,'UTF8')),'hex'),
        clock_timestamp(),'publish.delivery_recovery'
      );
      UPDATE app.workflow_run_active_admissions
         SET outbox_event_id=new_outbox_event_id,recover_after=NULL,
             recovery_count=recovery_count+1
       WHERE workflow_run_id=admission.workflow_run_id;
      recovered:=recovered+1;
    END IF;
  END LOOP;
  PERFORM set_config('app.workspace_id',coalesce(prior_workspace,''),true);
  RETURN recovered;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(prior_workspace,''),true);
  RAISE;
END $$;

ALTER TABLE app.workflow_run_active_admissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_run_active_admissions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workflow_run_active_admissions_owner
  ON app.workflow_run_active_admissions;
CREATE POLICY workflow_run_active_admissions_owner
  ON app.workflow_run_active_admissions FOR ALL TO {{owner_role}}
  USING(true) WITH CHECK(true);
DROP POLICY IF EXISTS outbox_events_active_admission_owner_select
  ON app.outbox_events;
CREATE POLICY outbox_events_active_admission_owner_select
  ON app.outbox_events FOR SELECT TO {{owner_role}}
  USING(workspace_id::text=nullif(current_setting('app.workspace_id',true),''));
DROP POLICY IF EXISTS outbox_events_active_admission_owner_update
  ON app.outbox_events;
CREATE POLICY outbox_events_active_admission_owner_update
  ON app.outbox_events FOR UPDATE TO {{owner_role}}
  USING(workspace_id::text=nullif(current_setting('app.workspace_id',true),''))
  WITH CHECK(workspace_id::text=nullif(current_setting('app.workspace_id',true),''));

REVOKE ALL ON app.workflow_run_active_admissions
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}};
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
