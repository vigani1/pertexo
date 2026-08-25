CREATE TABLE app.trigger_schedules (
  trigger_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  recurrence_kind varchar(16) NOT NULL,
  cron_expression varchar(256),
  timezone varchar(128),
  interval_minutes integer,
  misfire_policy varchar(32) NOT NULL,
  config_fingerprint varchar(82) NOT NULL,
  anchor_at timestamptz NOT NULL,
  next_fire_at timestamptz NOT NULL,
  last_fire_at timestamptz,
  status varchar(16) NOT NULL DEFAULT 'enabled',
  health_status varchar(32) NOT NULL DEFAULT 'healthy',
  last_error_code varchar(128),
  lease_owner varchar(128),
  lease_token uuid,
  lease_acquired_at timestamptz,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT trigger_schedules_workspace_identity_unique UNIQUE(workspace_id,trigger_id),
  CONSTRAINT trigger_schedules_trigger_fk FOREIGN KEY(workspace_id,trigger_id)
    REFERENCES app.workflow_triggers(workspace_id,id) ON DELETE RESTRICT,
  CONSTRAINT trigger_schedules_recurrence_valid CHECK(
    (recurrence_kind='cron' AND cron_expression IS NOT NULL AND timezone IS NOT NULL AND interval_minutes IS NULL) OR
    (recurrence_kind='interval' AND cron_expression IS NULL AND timezone IS NULL AND interval_minutes BETWEEN 1 AND 43200)
  ),
  CONSTRAINT trigger_schedules_misfire_valid CHECK(misfire_policy IN ('catch_up_once','skip')),
  CONSTRAINT trigger_schedules_status_valid CHECK(status IN ('enabled','disabled')),
  CONSTRAINT trigger_schedules_health_valid CHECK(health_status IN ('healthy','degraded','unhealthy','disabled')),
  CONSTRAINT trigger_schedules_fingerprint_valid CHECK(config_fingerprint ~ '^trigger:v1:sha256:[0-9a-f]{64}$'),
  CONSTRAINT trigger_schedules_cursor_valid CHECK(last_fire_at IS NULL OR last_fire_at<next_fire_at),
  CONSTRAINT trigger_schedules_lease_valid CHECK(
    (lease_owner IS NULL AND lease_token IS NULL AND lease_acquired_at IS NULL AND lease_expires_at IS NULL) OR
    (lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_acquired_at IS NOT NULL
      AND lease_expires_at>lease_acquired_at AND lease_expires_at<=lease_acquired_at+interval '5 minutes')
  )
);
CREATE INDEX trigger_schedules_due_idx ON app.trigger_schedules(next_fire_at,trigger_id)
  WHERE status='enabled';

CREATE TABLE app.trigger_schedule_occurrences (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  trigger_id uuid NOT NULL,
  scheduled_at timestamptz NOT NULL,
  disposition varchar(16) NOT NULL,
  workflow_run_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT trigger_schedule_occurrences_workspace_identity_unique UNIQUE(workspace_id,id),
  CONSTRAINT trigger_schedule_occurrences_identity_unique UNIQUE(trigger_id,scheduled_at),
  CONSTRAINT trigger_schedule_occurrences_schedule_fk FOREIGN KEY(workspace_id,trigger_id)
    REFERENCES app.trigger_schedules(workspace_id,trigger_id) ON DELETE RESTRICT,
  CONSTRAINT trigger_schedule_occurrences_run_fk FOREIGN KEY(workspace_id,workflow_run_id)
    REFERENCES app.workflow_runs(workspace_id,id) ON DELETE RESTRICT,
  CONSTRAINT trigger_schedule_occurrences_disposition_valid CHECK(
    (disposition='accepted' AND workflow_run_id IS NOT NULL) OR
    (disposition='skipped' AND workflow_run_id IS NULL)
  )
);
CREATE INDEX trigger_schedule_occurrences_trigger_time_idx
  ON app.trigger_schedule_occurrences(workspace_id,trigger_id,scheduled_at DESC,id);

CREATE FUNCTION app.reject_trigger_schedule_config_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NEW.trigger_id<>OLD.trigger_id OR NEW.workspace_id<>OLD.workspace_id
    OR NEW.recurrence_kind<>OLD.recurrence_kind
    OR NEW.cron_expression IS DISTINCT FROM OLD.cron_expression
    OR NEW.timezone IS DISTINCT FROM OLD.timezone
    OR NEW.interval_minutes IS DISTINCT FROM OLD.interval_minutes
    OR NEW.misfire_policy<>OLD.misfire_policy
    OR NEW.config_fingerprint<>OLD.config_fingerprint OR NEW.anchor_at<>OLD.anchor_at THEN
    RAISE EXCEPTION 'trigger schedule configuration is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trigger_schedules_config_immutable BEFORE UPDATE ON app.trigger_schedules
  FOR EACH ROW EXECUTE FUNCTION app.reject_trigger_schedule_config_mutation();

ALTER TABLE app.trigger_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.trigger_schedules FORCE ROW LEVEL SECURITY;
ALTER TABLE app.trigger_schedule_occurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.trigger_schedule_occurrences FORCE ROW LEVEL SECURITY;
CREATE POLICY trigger_schedules_workspace_scope ON app.trigger_schedules FOR ALL
  TO {{owner_role}},{{api_runtime_role}}
  USING(workspace_id::text=nullif(current_setting('app.workspace_id',true),''))
  WITH CHECK(workspace_id::text=nullif(current_setting('app.workspace_id',true),''));
CREATE POLICY trigger_schedules_owner_worker ON app.trigger_schedules FOR ALL TO {{owner_role}}
  USING(true) WITH CHECK(true);
CREATE POLICY trigger_schedule_occurrences_workspace_scope ON app.trigger_schedule_occurrences FOR ALL
  TO {{owner_role}},{{api_runtime_role}}
  USING(workspace_id::text=nullif(current_setting('app.workspace_id',true),''))
  WITH CHECK(workspace_id::text=nullif(current_setting('app.workspace_id',true),''));
CREATE POLICY trigger_schedule_occurrences_owner_worker ON app.trigger_schedule_occurrences FOR ALL TO {{owner_role}}
  USING(true) WITH CHECK(true);

CREATE FUNCTION app.claim_due_trigger_schedules(
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
  RETURN QUERY WITH due AS (
    SELECT schedule.trigger_id
      FROM app.trigger_schedules schedule
      JOIN app.workflow_triggers trigger ON trigger.id=schedule.trigger_id
     WHERE schedule.status='enabled' AND schedule.next_fire_at<=v_observed_at
       AND (schedule.lease_expires_at IS NULL OR schedule.lease_expires_at<=v_observed_at)
       AND trigger.status='active'
     ORDER BY schedule.next_fire_at,schedule.trigger_id
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
    ORDER BY claimed.next_fire_at,claimed.trigger_id;
END $$;

CREATE FUNCTION app.schedule_claim_is_eligible(p_trigger_id uuid,p_lease_token uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_workspace_id uuid; v_eligible boolean; v_prior_workspace text;
BEGIN
  v_prior_workspace := current_setting('app.workspace_id',true);
  SELECT trigger.workspace_id INTO v_workspace_id
    FROM app.workflow_triggers trigger WHERE trigger.id=p_trigger_id;
  IF v_workspace_id IS NULL THEN RETURN false; END IF;
  PERFORM set_config('app.workspace_id',v_workspace_id::text,true);
  SELECT EXISTS(SELECT 1 FROM app.trigger_schedules schedule
    JOIN app.workflow_triggers trigger ON trigger.id=schedule.trigger_id
    JOIN app.workflows workflow ON workflow.id=trigger.workflow_id
    JOIN app.workspaces workspace ON workspace.id=trigger.workspace_id
    WHERE schedule.trigger_id=p_trigger_id AND schedule.lease_token=p_lease_token
      AND schedule.lease_expires_at>clock_timestamp() AND schedule.status='enabled'
      AND trigger.status='active' AND workflow.lifecycle_status='active'
      AND workflow.activation_status IN ('active','degraded')
      AND workflow.published_version_id=trigger.workflow_version_id AND workspace.status='active'
  ) INTO v_eligible;
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RETURN v_eligible;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RAISE;
END
$$;

CREATE FUNCTION app.complete_trigger_schedule_claim(
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
    health_status='healthy',last_error_code=NULL,updated_at=clock_timestamp()
   WHERE trigger_id=p_trigger_id AND lease_token=p_lease_token;
  RETURN FOUND;
END $$;

CREATE FUNCTION app.release_trigger_schedule_claim(p_trigger_id uuid,p_lease_token uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
  UPDATE app.trigger_schedules SET lease_owner=NULL,lease_token=NULL,lease_acquired_at=NULL,
    lease_expires_at=NULL,updated_at=clock_timestamp()
   WHERE trigger_id=p_trigger_id AND lease_token=p_lease_token RETURNING true
$$;

REVOKE ALL ON app.trigger_schedules,app.trigger_schedule_occurrences
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}};
GRANT SELECT,INSERT ON app.trigger_schedules TO {{api_runtime_role}};
GRANT UPDATE(next_fire_at,last_fire_at,status,health_status,last_error_code,lease_owner,
  lease_token,lease_acquired_at,lease_expires_at,updated_at) ON app.trigger_schedules TO {{api_runtime_role}};
GRANT SELECT ON app.trigger_schedule_occurrences TO {{api_runtime_role}};
REVOKE ALL ON FUNCTION app.claim_due_trigger_schedules(varchar,integer,integer),
  app.schedule_claim_is_eligible(uuid,uuid),
  app.complete_trigger_schedule_claim(uuid,uuid,uuid,timestamptz,varchar,uuid,timestamptz),
  app.release_trigger_schedule_claim(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_due_trigger_schedules(varchar,integer,integer),
  app.schedule_claim_is_eligible(uuid,uuid),
  app.complete_trigger_schedule_claim(uuid,uuid,uuid,timestamptz,varchar,uuid,timestamptz),
  app.release_trigger_schedule_claim(uuid,uuid) TO {{worker_runtime_role}};
GRANT EXECUTE ON FUNCTION app.schedule_claim_is_eligible(uuid,uuid),
  app.complete_trigger_schedule_claim(uuid,uuid,uuid,timestamptz,varchar,uuid,timestamptz)
  TO {{api_runtime_role}};
