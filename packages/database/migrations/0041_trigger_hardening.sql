-- Phase 6 hardening. Destructive retention maintenance remains Phase 7 work.
ALTER TABLE app.webhook_trigger_deliveries
  ADD COLUMN expires_at timestamptz;
UPDATE app.webhook_trigger_deliveries SET expires_at=received_at+interval '90 days';
ALTER TABLE app.webhook_trigger_deliveries ALTER COLUMN expires_at SET NOT NULL;
ALTER TABLE app.webhook_trigger_deliveries ALTER COLUMN expires_at
  SET DEFAULT (clock_timestamp()+interval '90 days');
ALTER TABLE app.webhook_trigger_deliveries ADD CONSTRAINT webhook_trigger_deliveries_retention_valid
  CHECK(expires_at>=received_at+interval '89 days 23 hours 59 minutes 59 seconds'
    AND expires_at<=received_at+interval '90 days 1 second');
CREATE INDEX webhook_trigger_deliveries_expiry_idx
  ON app.webhook_trigger_deliveries(expires_at,id);
ALTER TABLE app.webhook_trigger_replay_records ADD CONSTRAINT webhook_trigger_replay_retention_valid
  CHECK(
    (dedupe_kind='fingerprint' AND expires_at>=created_at+interval '4 minutes 59 seconds'
      AND expires_at<=created_at+interval '5 minutes 1 second') OR
    (dedupe_kind='keyed' AND expires_at>=created_at+interval '23 hours 59 minutes 59 seconds'
      AND expires_at<=created_at+interval '24 hours 1 second')
  );

CREATE TABLE app.webhook_endpoint_ingress_limits (
  endpoint_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  bucket_started_at timestamptz NOT NULL,
  request_count integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT webhook_endpoint_ingress_limits_endpoint_fk FOREIGN KEY(workspace_id,endpoint_id)
    REFERENCES app.webhook_trigger_endpoints(workspace_id,id) ON DELETE CASCADE,
  CONSTRAINT webhook_endpoint_ingress_limits_count_valid CHECK(request_count BETWEEN 1 AND 60)
);
ALTER TABLE app.webhook_endpoint_ingress_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.webhook_endpoint_ingress_limits FORCE ROW LEVEL SECURITY;
CREATE POLICY webhook_endpoint_ingress_limits_owner ON app.webhook_endpoint_ingress_limits
  FOR ALL TO {{owner_role}} USING(true) WITH CHECK(true);
REVOKE ALL ON app.webhook_endpoint_ingress_limits
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}};

CREATE FUNCTION app.consume_webhook_ingress_limit(p_endpoint_key_hash char(64))
RETURNS TABLE(allowed boolean,retry_after_seconds integer)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_endpoint_id uuid;
  v_workspace_id uuid;
  v_now timestamptz := clock_timestamp();
  v_started timestamptz;
  v_count integer;
BEGIN
  SELECT endpoint.id,endpoint.workspace_id INTO v_endpoint_id,v_workspace_id
    FROM app.webhook_trigger_endpoints endpoint
    JOIN app.workflow_triggers trigger ON trigger.id=endpoint.trigger_id
   WHERE endpoint.endpoint_key_hash=p_endpoint_key_hash
     AND endpoint.status='active' AND trigger.status='active';
  IF v_endpoint_id IS NULL THEN RETURN QUERY SELECT false,1; RETURN; END IF;

  INSERT INTO app.webhook_endpoint_ingress_limits
    (endpoint_id,workspace_id,bucket_started_at,request_count)
    VALUES(v_endpoint_id,v_workspace_id,v_now,1)
    ON CONFLICT(endpoint_id) DO NOTHING;
  IF FOUND THEN RETURN QUERY SELECT true,0; RETURN; END IF;
  SELECT bucket_started_at,request_count INTO v_started,v_count
    FROM app.webhook_endpoint_ingress_limits WHERE endpoint_id=v_endpoint_id FOR UPDATE;
  IF v_started+interval '1 minute'<=v_now THEN
    UPDATE app.webhook_endpoint_ingress_limits SET bucket_started_at=v_now,
      request_count=1,updated_at=v_now WHERE endpoint_id=v_endpoint_id;
    RETURN QUERY SELECT true,0; RETURN;
  END IF;
  IF v_count>=60 THEN
    RETURN QUERY SELECT false,greatest(1,least(60,
      ceil(extract(epoch FROM (v_started+interval '1 minute'-v_now)))::integer));
    RETURN;
  END IF;
  UPDATE app.webhook_endpoint_ingress_limits SET request_count=request_count+1,
    updated_at=v_now WHERE endpoint_id=v_endpoint_id;
  RETURN QUERY SELECT true,0;
END $$;
REVOKE ALL ON FUNCTION app.consume_webhook_ingress_limit(char) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.consume_webhook_ingress_limit(char) TO {{api_runtime_role}};

ALTER TABLE app.trigger_schedules ADD COLUMN admission_deferred_until timestamptz;
DROP INDEX app.trigger_schedules_due_idx;
CREATE INDEX trigger_schedules_due_idx
  ON app.trigger_schedules(next_fire_at,workspace_id,trigger_id) WHERE status='enabled';

CREATE OR REPLACE FUNCTION app.claim_due_trigger_schedules(
  p_lease_owner varchar,p_limit integer,p_lease_seconds integer
) RETURNS TABLE(
  trigger_id uuid,workspace_id uuid,workflow_id uuid,workflow_version_id uuid,node_id varchar,
  recurrence_kind varchar,cron_expression varchar,timezone varchar,interval_minutes integer,
  misfire_policy varchar,config_fingerprint varchar,anchor_at timestamptz,next_fire_at timestamptz,
  lease_token uuid,observed_at timestamptz
) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_observed_at timestamptz := clock_timestamp();
BEGIN
  IF p_lease_owner IS NULL OR length(p_lease_owner)<1 OR length(p_lease_owner)>128
    OR p_limit<1 OR p_limit>100 OR p_lease_seconds<1 OR p_lease_seconds>300 THEN
    RAISE EXCEPTION 'invalid schedule claim bounds' USING ERRCODE='22023';
  END IF;
  RETURN QUERY WITH ranked AS (
    SELECT schedule.trigger_id,row_number() over (partition by schedule.workspace_id
      ORDER BY schedule.next_fire_at,schedule.trigger_id) AS workspace_rank
      FROM app.trigger_schedules schedule
      JOIN app.workflow_triggers trigger ON trigger.id=schedule.trigger_id
     WHERE schedule.status='enabled' AND schedule.next_fire_at<=v_observed_at
       AND (schedule.admission_deferred_until IS NULL OR schedule.admission_deferred_until<=v_observed_at)
       AND (schedule.lease_expires_at IS NULL OR schedule.lease_expires_at<=v_observed_at)
       AND trigger.status='active'
  ), due AS (
    SELECT schedule.trigger_id FROM app.trigger_schedules schedule
      JOIN ranked ON ranked.trigger_id=schedule.trigger_id AND ranked.workspace_rank=1
     ORDER BY schedule.next_fire_at,schedule.workspace_id,schedule.trigger_id
     LIMIT p_limit FOR UPDATE OF schedule SKIP LOCKED
  ), claimed AS (
    UPDATE app.trigger_schedules schedule SET lease_owner=p_lease_owner,
      lease_token=gen_random_uuid(),lease_acquired_at=v_observed_at,
      lease_expires_at=v_observed_at+make_interval(secs=>p_lease_seconds),updated_at=v_observed_at
      FROM due WHERE schedule.trigger_id=due.trigger_id RETURNING schedule.*
  ) SELECT claimed.trigger_id,claimed.workspace_id,trigger.workflow_id,trigger.workflow_version_id,
      trigger.node_id,claimed.recurrence_kind,claimed.cron_expression,claimed.timezone,
      claimed.interval_minutes,claimed.misfire_policy,claimed.config_fingerprint,claimed.anchor_at,
      claimed.next_fire_at,claimed.lease_token,v_observed_at
    FROM claimed JOIN app.workflow_triggers trigger ON trigger.id=claimed.trigger_id
    ORDER BY claimed.next_fire_at,claimed.workspace_id,claimed.trigger_id;
END $$;

CREATE FUNCTION app.defer_trigger_schedule_claim(
  p_trigger_id uuid,p_lease_token uuid,p_retry_seconds integer
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_workspace_id uuid;
BEGIN
  IF p_retry_seconds<1 OR p_retry_seconds>300 THEN
    RAISE EXCEPTION 'invalid schedule admission backoff' USING ERRCODE='22023';
  END IF;
  UPDATE app.trigger_schedules SET lease_owner=NULL,lease_token=NULL,lease_acquired_at=NULL,
    lease_expires_at=NULL,admission_deferred_until=clock_timestamp()+make_interval(secs=>p_retry_seconds),
    health_status='degraded',last_error_code='schedule.admission_throttled',updated_at=clock_timestamp()
   WHERE trigger_id=p_trigger_id AND lease_token=p_lease_token RETURNING workspace_id INTO v_workspace_id;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE app.workflow_triggers SET health_status='degraded',last_error_code='schedule.admission_throttled',
    updated_at=clock_timestamp() WHERE id=p_trigger_id AND workspace_id=v_workspace_id;
  RETURN true;
END $$;

CREATE FUNCTION app.fail_trigger_schedule_claim(p_trigger_id uuid,p_lease_token uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_workspace_id uuid;
BEGIN
  UPDATE app.trigger_schedules SET lease_owner=NULL,lease_token=NULL,lease_acquired_at=NULL,
    lease_expires_at=NULL,health_status='degraded',last_error_code='schedule.scan_failed',
    updated_at=clock_timestamp() WHERE trigger_id=p_trigger_id AND lease_token=p_lease_token
    RETURNING workspace_id INTO v_workspace_id;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE app.workflow_triggers SET health_status='degraded',last_error_code='schedule.scan_failed',
    updated_at=clock_timestamp() WHERE id=p_trigger_id AND workspace_id=v_workspace_id;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION app.complete_trigger_schedule_claim(
  p_trigger_id uuid,p_lease_token uuid,p_occurrence_id uuid,p_scheduled_at timestamptz,
  p_disposition varchar,p_workflow_run_id uuid,p_next_fire_at timestamptz
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_schedule app.trigger_schedules%ROWTYPE;
BEGIN
  SELECT * INTO v_schedule FROM app.trigger_schedules WHERE trigger_id=p_trigger_id
    AND lease_token=p_lease_token AND lease_expires_at>clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO app.trigger_schedule_occurrences
    (id,workspace_id,trigger_id,scheduled_at,disposition,workflow_run_id)
    VALUES(p_occurrence_id,v_schedule.workspace_id,p_trigger_id,p_scheduled_at,p_disposition,p_workflow_run_id)
    ON CONFLICT(trigger_id,scheduled_at) DO NOTHING;
  UPDATE app.trigger_schedules SET last_fire_at=p_scheduled_at,next_fire_at=p_next_fire_at,
    lease_owner=NULL,lease_token=NULL,lease_acquired_at=NULL,lease_expires_at=NULL,
    admission_deferred_until=NULL,health_status='healthy',last_error_code=NULL,updated_at=clock_timestamp()
   WHERE trigger_id=p_trigger_id AND lease_token=p_lease_token;
  UPDATE app.workflow_triggers SET health_status='healthy',last_error_code=NULL,updated_at=clock_timestamp()
   WHERE id=p_trigger_id AND workspace_id=v_schedule.workspace_id;
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION app.defer_trigger_schedule_claim(uuid,uuid,integer),
  app.fail_trigger_schedule_claim(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.defer_trigger_schedule_claim(uuid,uuid,integer),
  app.fail_trigger_schedule_claim(uuid,uuid) TO {{worker_runtime_role}};

-- Trigger lifecycle reconciliation runs in the worker. Grant only its tenant-scoped
-- materialization columns; execution payload and credential columns remain excluded.
CREATE POLICY workflows_worker_trigger_reconciliation ON app.workflows FOR ALL
  TO {{worker_runtime_role}}
  USING(workspace_id::text=nullif(current_setting('app.workspace_id',true),''))
  WITH CHECK(workspace_id::text=nullif(current_setting('app.workspace_id',true),''));
CREATE POLICY workflow_triggers_worker_reconciliation ON app.workflow_triggers FOR ALL
  TO {{worker_runtime_role}}
  USING(workspace_id::text=nullif(current_setting('app.workspace_id',true),''))
  WITH CHECK(workspace_id::text=nullif(current_setting('app.workspace_id',true),''));
CREATE POLICY webhook_trigger_endpoints_worker_reconciliation ON app.webhook_trigger_endpoints FOR ALL
  TO {{worker_runtime_role}}
  USING(workspace_id::text=nullif(current_setting('app.workspace_id',true),''))
  WITH CHECK(workspace_id::text=nullif(current_setting('app.workspace_id',true),''));
CREATE POLICY trigger_schedules_worker_reconciliation ON app.trigger_schedules FOR ALL
  TO {{worker_runtime_role}}
  USING(workspace_id::text=nullif(current_setting('app.workspace_id',true),''))
  WITH CHECK(workspace_id::text=nullif(current_setting('app.workspace_id',true),''));

GRANT SELECT(id,workspace_id,lifecycle_status,published_version_id,activation_status)
  ON app.workflows TO {{worker_runtime_role}};
GRANT SELECT ON app.workflow_triggers,app.trigger_schedules TO {{worker_runtime_role}};
GRANT SELECT(id,workspace_id,trigger_id,status)
  ON app.webhook_trigger_endpoints TO {{worker_runtime_role}};
GRANT UPDATE(activation_status,updated_at) ON app.workflows TO {{worker_runtime_role}};
GRANT UPDATE(status,health_status,last_error_code,reconciled_at,updated_at)
  ON app.workflow_triggers TO {{worker_runtime_role}};
GRANT UPDATE(status,updated_at) ON app.webhook_trigger_endpoints TO {{worker_runtime_role}};
GRANT INSERT ON app.trigger_schedules TO {{worker_runtime_role}};
GRANT UPDATE(next_fire_at,last_fire_at,status,health_status,last_error_code,lease_owner,
  lease_token,lease_acquired_at,lease_expires_at,admission_deferred_until,updated_at)
  ON app.trigger_schedules TO {{worker_runtime_role}};
