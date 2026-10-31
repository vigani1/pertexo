-- dm-07, performance-04: limits are instance settings the operator sets, not values fixed at
-- workspace creation, and a timed Wait holds no workspace slot. ADR 069 (reason for new SQL): these
-- stay in PostgreSQL because they are the capacity counters. apply_instance_capacity crosses
-- workspaces, which only a definer function can do for the app role; enforce_workflow_run_admission,
-- workflow_run_slot_counts and the provisioning trigger change because they read the limits and slots.
CREATE TABLE "app"."instance_capacity" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"active_run_limit" integer NOT NULL,
	"queued_run_limit" integer NOT NULL,
	"artifact_count_limit" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "instance_capacity_singleton" CHECK ("app"."instance_capacity"."singleton"),
	CONSTRAINT "instance_capacity_limits_valid" CHECK (active_run_limit BETWEEN 1 AND 10000 AND queued_run_limit BETWEEN 1 AND 100000 AND artifact_count_limit >= 0)
);
--> statement-breakpoint
-- Starts at what existing workspaces hold, so applying the new defaults below reaches them.
INSERT INTO app.instance_capacity(active_run_limit,queued_run_limit,artifact_count_limit) VALUES (5,100,1000);--> statement-breakpoint
GRANT SELECT ON TABLE app.instance_capacity TO {{app_role}},{{maintenance_role}};--> statement-breakpoint
CREATE FUNCTION app.instance_artifact_count_limit() RETURNS integer
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'app'
    AS $$ SELECT artifact_count_limit FROM app.instance_capacity $$;--> statement-breakpoint
ALTER TABLE "app"."webhook_endpoint_ingress_limits" DROP CONSTRAINT "webhook_endpoint_ingress_limits_count_valid";--> statement-breakpoint
ALTER TABLE "app"."webhook_endpoint_ingress_limits" ADD CONSTRAINT "webhook_endpoint_ingress_limits_count_valid" CHECK ((request_count >= 1));--> statement-breakpoint
ALTER TABLE "app"."workspace_artifact_capacity" ALTER COLUMN "artifact_count_limit" SET DEFAULT app.instance_artifact_count_limit();--> statement-breakpoint
ALTER TABLE "app"."workflow_runs" ADD COLUMN "timed_wait_started_at" timestamp with time zone;--> statement-breakpoint
GRANT UPDATE (timed_wait_started_at) ON app.workflow_runs TO {{app_role}};--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.provision_workspace_execution_admission() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
DECLARE prior_workspace text;
BEGIN
  prior_workspace := current_setting('app.workspace_id',true);
  PERFORM set_config('app.workspace_id',NEW.id::text,true);
  INSERT INTO app.workspace_execution_entitlement_versions (
    workspace_id,version,status,active_run_limit,queued_run_limit,effective_at
  ) SELECT NEW.id,1,'active',capacity.active_run_limit,capacity.queued_run_limit,'-infinity'::timestamptz
      FROM app.instance_capacity capacity;
  INSERT INTO app.workspace_execution_entitlements(workspace_id,current_version)
    VALUES (NEW.id,1);
  INSERT INTO app.workspace_execution_admission_counters(workspace_id)
    VALUES (NEW.id);
  PERFORM set_config('app.workspace_id',coalesce(prior_workspace,''),true);
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE FUNCTION app.apply_instance_capacity(p_active_run_limit integer, p_queued_run_limit integer, p_artifact_count_limit integer) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
DECLARE
  current_limits app.instance_capacity%ROWTYPE;
  prior_workspace text;
  workspace uuid;
BEGIN
  SELECT * INTO current_limits FROM app.instance_capacity FOR UPDATE;
  IF current_limits.active_run_limit=p_active_run_limit
     AND current_limits.queued_run_limit=p_queued_run_limit
     AND current_limits.artifact_count_limit=p_artifact_count_limit THEN
    RETURN;
  END IF;
  UPDATE app.instance_capacity SET active_run_limit=p_active_run_limit,
    queued_run_limit=p_queued_run_limit,artifact_count_limit=p_artifact_count_limit,
    updated_at=clock_timestamp();
  UPDATE app.workspace_artifact_capacity SET artifact_count_limit=p_artifact_count_limit,
    updated_at=clock_timestamp();
  prior_workspace := current_setting('app.workspace_id',true);
  FOR workspace IN SELECT id FROM app.workspaces LOOP
    PERFORM set_config('app.workspace_id',workspace::text,true);
    UPDATE app.workspace_execution_entitlement_versions
       SET active_run_limit=p_active_run_limit,queued_run_limit=p_queued_run_limit
     WHERE workspace_id=workspace;
  END LOOP;
  PERFORM set_config('app.workspace_id',coalesce(prior_workspace,''),true);
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app.apply_instance_capacity(integer,integer,integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.apply_instance_capacity(integer,integer,integer) TO {{app_role}};--> statement-breakpoint
SELECT app.apply_instance_capacity(20,10000,10000);--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.workflow_run_slot_counts(
  p_workspace uuid, p_workflow uuid DEFAULT NULL, p_excluded_run uuid DEFAULT NULL
) RETURNS TABLE(active_runs integer, reserved_active_slots integer, queued_runs integer)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path TO 'pg_catalog', 'app'
  SET row_security TO 'on'
AS $$
BEGIN
  IF nullif(current_setting('app.workspace_id',true),'')::uuid IS DISTINCT FROM p_workspace THEN
    RAISE EXCEPTION 'workspace context mismatch' USING ERRCODE='42501';
  END IF;
  RETURN QUERY SELECT
    (SELECT count(*)::integer FROM app.workflow_runs run
      WHERE run.workspace_id=p_workspace AND run.status IN ('running','waiting') AND run.human_wait_started_at IS NULL
        -- A timed Wait holds no workspace slot, but keeps its place in the workflow's own limit.
        AND (p_workflow IS NOT NULL OR run.timed_wait_started_at IS NULL)
        AND (p_workflow IS NULL OR run.workflow_id=p_workflow)
        AND (p_excluded_run IS NULL OR run.id<>p_excluded_run)
        AND (p_workflow IS NOT NULL OR NOT EXISTS (
          SELECT 1 FROM app.workflow_calls call WHERE call.workspace_id=p_workspace
            AND call.parent_run_id=run.id AND call.slot_lent))),
    (SELECT count(*)::integer FROM app.workflow_run_active_admissions admission
      JOIN app.workflow_runs run
        ON run.workspace_id=admission.workspace_id AND run.id=admission.workflow_run_id
      WHERE admission.workspace_id=p_workspace AND run.human_wait_started_at IS NULL AND run.status NOT IN ('running','waiting')
        AND (p_workflow IS NULL OR (run.workflow_id=p_workflow AND run.status='queued'))
        AND (p_excluded_run IS NULL OR run.id<>p_excluded_run)),
    (SELECT count(*)::integer FROM app.workflow_runs run
      WHERE run.workspace_id=p_workspace AND run.status='queued'
        AND (p_workflow IS NULL OR run.workflow_id=p_workflow)
        AND (p_excluded_run IS NULL OR run.id<>p_excluded_run));
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.enforce_workflow_run_admission() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
DECLARE
  entitlement record;
  actual_queued integer;
  actual_active integer;
  reserved_active integer;
  next_queued integer;
  next_active integer;
  workspace_status text;
BEGIN
  IF TG_OP='UPDATE' AND NEW.admission_ticket IS DISTINCT FROM OLD.admission_ticket THEN
    RAISE EXCEPTION 'admission ticket is immutable' USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' AND NEW.status IN ('running','waiting')
     AND EXISTS(SELECT 1 FROM app.workflow_concurrency_policies WHERE workspace_id=NEW.workspace_id
       AND workflow_id=NEW.workflow_id AND active_run_limit IS NOT NULL) THEN
    IF current_setting('app.workflow_concurrency_protocol',true) IS DISTINCT FROM '1' THEN
      RAISE EXCEPTION 'workflow concurrency protocol required' USING ERRCODE='PTC01';
    END IF;
    RAISE EXCEPTION 'capped production runs must enter the durable queue' USING ERRCODE='PTC02';
  END IF;
  IF TG_OP='UPDATE' AND OLD.status='queued' AND NEW.status IN ('running','waiting')
     AND (OLD.cancel_requested_at IS NOT NULL OR OLD.deadline_at<=clock_timestamp()) THEN
    RAISE EXCEPTION 'terminal control cannot start work' USING ERRCODE='PTC02';
  END IF;
  IF TG_OP='UPDATE' AND OLD.status='queued' AND NEW.status IN ('running','waiting')
     AND EXISTS(SELECT 1 FROM app.workflow_concurrency_policies WHERE workspace_id=NEW.workspace_id
       AND workflow_id=NEW.workflow_id AND active_run_limit IS NOT NULL)
     AND current_setting('app.workflow_concurrency_protocol',true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'workflow concurrency protocol required' USING ERRCODE='PTC01';
  END IF;
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
  -- Re-read the policy after the workspace counter serializes settings writes.
  -- The early guard cannot see a cap committed while this INSERT waits.
  IF TG_OP='INSERT' AND NEW.status IN ('running','waiting')
     AND EXISTS(SELECT 1 FROM app.workflow_concurrency_policies WHERE workspace_id=NEW.workspace_id
       AND workflow_id=NEW.workflow_id AND active_run_limit IS NOT NULL) THEN
    IF current_setting('app.workflow_concurrency_protocol',true) IS DISTINCT FROM '1' THEN
      RAISE EXCEPTION 'workflow concurrency protocol required' USING ERRCODE='PTC01';
    END IF;
    RAISE EXCEPTION 'capped production runs must enter the durable queue' USING ERRCODE='PTC02';
  END IF;
  IF TG_OP='INSERT' THEN
    NEW.admission_ticket:=nextval('app.workflow_run_admission_ticket_seq');
  END IF;
  SELECT queued_runs,active_runs,reserved_active_slots
    INTO actual_queued,actual_active,reserved_active
    FROM app.workflow_run_slot_counts(NEW.workspace_id,NULL,
      CASE WHEN TG_OP='UPDATE' THEN OLD.id ELSE NULL END);
  next_queued:=actual_queued+CASE WHEN NEW.status='queued' THEN 1 ELSE 0 END;
  next_active:=actual_active+reserved_active;
  IF NEW.status IN ('running','waiting') AND NEW.human_wait_started_at IS NULL AND NEW.timed_wait_started_at IS NULL THEN
    IF NOT EXISTS(SELECT 1 FROM app.workflow_calls call
      WHERE call.workspace_id=NEW.workspace_id AND call.parent_run_id=NEW.id AND call.slot_lent) THEN
      next_active:=next_active+1;
    END IF;
  ELSIF TG_OP='UPDATE' AND NEW.status NOT IN ('running','waiting') AND NEW.human_wait_started_at IS NULL AND EXISTS(SELECT 1 FROM app.workflow_run_active_admissions admission
    WHERE admission.workspace_id=NEW.workspace_id AND admission.workflow_run_id=OLD.id) THEN
    next_active:=next_active+1;
  END IF;
  IF TG_OP='INSERT' THEN
    NEW.execution_entitlement_version:=entitlement.version;
  ELSIF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR
     NEW.execution_entitlement_version IS DISTINCT FROM OLD.execution_entitlement_version THEN
    RAISE EXCEPTION 'workflow run admission identity is immutable' USING ERRCODE='55000';
  END IF;
  IF ((TG_OP='INSERT' AND NEW.status='queued') OR
      (TG_OP='UPDATE' AND OLD.status<>'queued' AND NEW.status='queued')) AND
     next_queued>entitlement.queued_run_limit THEN
    RAISE EXCEPTION 'workspace.queued_run_limit_exceeded' USING ERRCODE='PTA02';
  END IF;
  IF ((TG_OP='INSERT' AND NEW.status IN ('running','waiting')) OR
      (TG_OP='UPDATE' AND (OLD.status NOT IN ('running','waiting') OR OLD.human_wait_started_at IS NOT NULL OR OLD.timed_wait_started_at IS NOT NULL)
       AND NEW.status IN ('running','waiting') AND NEW.human_wait_started_at IS NULL AND NEW.timed_wait_started_at IS NULL)) AND
     next_active>entitlement.active_run_limit
     AND NOT EXISTS(SELECT 1 FROM app.workflow_run_active_admissions admission
       WHERE admission.workspace_id=NEW.workspace_id AND admission.workflow_run_id=NEW.id
         AND admission.borrowed_call_id IS NOT NULL AND (TG_OP='INSERT' OR OLD.human_wait_started_at IS NULL))
     AND NOT EXISTS(SELECT 1 FROM app.workflow_calls loan WHERE loan.workspace_id=NEW.workspace_id AND loan.parent_run_id=NEW.id AND loan.slot_lent) THEN
    RAISE EXCEPTION 'workspace.active_run_limit_exceeded' USING ERRCODE='PTA03';
  END IF;
  IF TG_OP='UPDATE' AND (OLD.status='queued' OR OLD.human_wait_started_at IS NOT NULL) AND NEW.status IN ('running','waiting') AND NEW.human_wait_started_at IS NULL
     AND NOT app.workflow_concurrency_admissible(NEW.workspace_id,NEW.id,false) THEN
    RAISE EXCEPTION 'workflow concurrency admission blocked' USING ERRCODE='PTC02';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER workflow_runs_execution_admission ON app.workflow_runs;--> statement-breakpoint
CREATE TRIGGER workflow_runs_execution_admission BEFORE INSERT OR UPDATE OF workspace_id,status,execution_entitlement_version,human_wait_started_at,timed_wait_started_at ON app.workflow_runs
  FOR EACH ROW EXECUTE FUNCTION app.enforce_workflow_run_admission();--> statement-breakpoint
DROP TRIGGER workflow_runs_refresh_execution_admission ON app.workflow_runs;--> statement-breakpoint
CREATE TRIGGER workflow_runs_refresh_execution_admission AFTER INSERT OR UPDATE OF workspace_id,status,execution_entitlement_version,human_wait_started_at,timed_wait_started_at ON app.workflow_runs
  FOR EACH ROW EXECUTE FUNCTION app.refresh_workflow_run_admission_counters();--> statement-breakpoint
DROP FUNCTION app.consume_webhook_ingress_limit(character);--> statement-breakpoint
CREATE FUNCTION app.consume_webhook_ingress_limit(p_endpoint_key_hash character, p_burst_limit integer) RETURNS TABLE(allowed boolean, retry_after_seconds integer)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE
  v_endpoint_id uuid;
  v_workspace_id uuid;
  v_now timestamptz := clock_timestamp();
  v_started timestamptz;
  v_count integer;
BEGIN
  SELECT endpoint.id,endpoint.workspace_id INTO v_endpoint_id,v_workspace_id
    FROM app.webhook_trigger_endpoints endpoint
   WHERE endpoint.endpoint_key_hash=p_endpoint_key_hash AND endpoint.status='active';
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
  IF v_count>=p_burst_limit THEN
    RETURN QUERY SELECT false,greatest(1,least(60,
      ceil(extract(epoch FROM (v_started+interval '1 minute'-v_now)))::integer));
    RETURN;
  END IF;
  UPDATE app.webhook_endpoint_ingress_limits SET request_count=request_count+1,
    updated_at=v_now WHERE endpoint_id=v_endpoint_id;
  RETURN QUERY SELECT true,0;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app.consume_webhook_ingress_limit(character,integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.consume_webhook_ingress_limit(character,integer) TO {{app_role}};
