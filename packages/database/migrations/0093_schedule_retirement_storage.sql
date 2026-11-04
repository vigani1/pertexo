-- Core chooses health, safe cause and retry time; storage fences the owning lease.
CREATE FUNCTION app.store_trigger_schedule_retirement(
  p_trigger_id uuid, p_lease_token uuid, p_health_status text,
  p_error_code text, p_deferred_until timestamptz
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on
AS $function$
DECLARE v_workspace_id uuid; v_previous_workspace text := current_setting('app.workspace_id',true);
BEGIN
  UPDATE app.trigger_schedules SET
    lease_owner=NULL,lease_token=NULL,lease_acquired_at=NULL,lease_expires_at=NULL,
    health_status=p_health_status,last_error_code=p_error_code,
    admission_deferred_until=p_deferred_until,updated_at=clock_timestamp()
  WHERE trigger_id=p_trigger_id AND lease_token=p_lease_token
    AND lease_expires_at>clock_timestamp()
  RETURNING workspace_id INTO v_workspace_id;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM set_config('app.workspace_id',v_workspace_id::text,true);
  UPDATE app.workflow_triggers SET health_status=p_health_status,
    last_error_code=p_error_code,updated_at=clock_timestamp()
  WHERE id=p_trigger_id AND workspace_id=v_workspace_id;
  PERFORM set_config('app.workspace_id',coalesce(v_previous_workspace,''),true);
  RETURN true;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.store_trigger_schedule_retirement(uuid,uuid,text,text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.store_trigger_schedule_retirement(uuid,uuid,text,text,timestamptz) TO {{app_role}};
--> statement-breakpoint
DROP FUNCTION app.defer_trigger_schedule_claim(uuid,uuid,integer);
DROP FUNCTION app.fail_trigger_schedule_claim(uuid,uuid);
