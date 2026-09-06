-- Recheck eligibility on the tuple locked by the claiming statement. The
-- ranked snapshot alone cannot fence a claim committed by another scanner.
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
      JOIN app.workflow_triggers trigger ON trigger.id=schedule.trigger_id
     WHERE schedule.status='enabled' AND schedule.next_fire_at<=v_observed_at
       AND (schedule.admission_deferred_until IS NULL OR schedule.admission_deferred_until<=v_observed_at)
       AND (schedule.lease_expires_at IS NULL OR schedule.lease_expires_at<=v_observed_at)
       AND trigger.status='active'
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

ALTER FUNCTION app.claim_due_trigger_schedules(varchar,integer,integer) OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.claim_due_trigger_schedules(varchar,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_due_trigger_schedules(varchar,integer,integer) TO {{worker_runtime_role}};
