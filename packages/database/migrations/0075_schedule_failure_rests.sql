CREATE OR REPLACE FUNCTION app.fail_trigger_schedule_claim(p_trigger_id uuid, p_lease_token uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE v_workspace_id uuid;
BEGIN
  -- A scan claims one schedule per workspace, the most overdue. A schedule that can't
  -- be processed rests a minute, or it would be that one every scan and no other
  -- schedule in its workspace would ever fire.
  UPDATE app.trigger_schedules SET lease_owner=NULL,lease_token=NULL,lease_acquired_at=NULL,
    lease_expires_at=NULL,admission_deferred_until=clock_timestamp()+interval '60 seconds',
    health_status='degraded',last_error_code='schedule.scan_failed',
    updated_at=clock_timestamp() WHERE trigger_id=p_trigger_id AND lease_token=p_lease_token
    RETURNING workspace_id INTO v_workspace_id;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE app.workflow_triggers SET health_status='degraded',last_error_code='schedule.scan_failed',
    updated_at=clock_timestamp() WHERE id=p_trigger_id AND workspace_id=v_workspace_id;
  RETURN true;
END $$;
