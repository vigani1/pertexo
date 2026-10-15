CREATE TABLE "app"."pending_run_tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"workflow_version_id" uuid NOT NULL,
	"node_run_id" uuid NOT NULL,
	"invocation_key" varchar(256) NOT NULL,
	"kind" varchar(32) NOT NULL,
	"config" jsonb NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"output_ref" jsonb,
	"decided_by" uuid,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "pending_run_tasks_workspace_identity_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "pending_run_tasks_invocation_unique" UNIQUE("workspace_id","run_id","invocation_key"),
	CONSTRAINT "pending_run_tasks_kind_valid" CHECK (kind = 'approval'),
	CONSTRAINT "pending_run_tasks_config_bounded" CHECK (jsonb_typeof(config) = 'object' AND octet_length(config::text) <= 16384),
	CONSTRAINT "pending_run_tasks_output_bounded" CHECK (output_ref IS NULL OR octet_length(output_ref::text) <= 4194304),
	CONSTRAINT "pending_run_tasks_expiry_valid" CHECK (expires_at > created_at AND expires_at <= created_at + interval '30 days'),
	CONSTRAINT "pending_run_tasks_state_valid" CHECK (((status = 'pending' AND output_ref IS NULL AND decided_by IS NULL AND completed_at IS NULL AND consumed_at IS NULL)
    OR (status IN ('approved','rejected') AND output_ref IS NOT NULL AND decided_by IS NOT NULL AND completed_at IS NOT NULL)
    OR (status IN ('expired','refused','canceled') AND output_ref IS NULL AND decided_by IS NULL AND completed_at IS NOT NULL)) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "app"."node_runs" DROP CONSTRAINT "node_runs_control_kind_valid";--> statement-breakpoint
ALTER TABLE "app"."node_runs" DROP CONSTRAINT "node_runs_wait_state_valid";--> statement-breakpoint
ALTER TABLE "app"."workflow_runs" ADD COLUMN "started_by" uuid;--> statement-breakpoint
ALTER TABLE "app"."workflow_runs" ADD COLUMN "absolute_deadline_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."workflow_runs" ADD COLUMN "human_wait_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."workflow_runs" ADD COLUMN "remaining_execution_ms" integer;--> statement-breakpoint
ALTER TABLE "app"."pending_run_tasks" ADD CONSTRAINT "pending_run_tasks_run_fk" FOREIGN KEY ("workspace_id","run_id","workflow_version_id") REFERENCES "app"."workflow_runs"("workspace_id","id","workflow_version_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."pending_run_tasks" ADD CONSTRAINT "pending_run_tasks_node_fk" FOREIGN KEY ("workspace_id","node_run_id") REFERENCES "app"."node_runs"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."pending_run_tasks" ADD CONSTRAINT "pending_run_tasks_decider_fk" FOREIGN KEY ("decided_by") REFERENCES "app"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pending_run_tasks_unconsumed_run_idx" ON "app"."pending_run_tasks" USING btree ("workspace_id","run_id") WHERE consumed_at IS NULL;--> statement-breakpoint
CREATE INDEX "pending_run_tasks_workspace_status_idx" ON "app"."pending_run_tasks" USING btree ("workspace_id","status","id");--> statement-breakpoint
ALTER TABLE "app"."workflow_runs" ADD CONSTRAINT "workflow_runs_starter_fk" FOREIGN KEY ("started_by") REFERENCES "app"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."node_runs" ADD CONSTRAINT "node_runs_control_kind_valid" CHECK (((control_kind IS NULL) OR ((control_kind)::text IN ('for_each_barrier'::text, 'workflow_call'::text, 'human_task'::text))));--> statement-breakpoint
ALTER TABLE "app"."node_runs" ADD CONSTRAINT "node_runs_wait_state_valid" CHECK ((((((status)::text = 'waiting'::text) AND ((control_kind)::text IN ('for_each_barrier'::text, 'workflow_call'::text)) AND (wait_kind IS NULL) AND (resume_at IS NULL) AND (retry_due_at IS NULL)) OR (status = 'waiting' AND control_kind = 'human_task' AND wait_kind IS NULL AND resume_at IS NOT NULL AND retry_due_at IS NULL) OR (((status)::text = 'waiting'::text) AND (control_kind IS NULL) AND ((((wait_kind)::text = 'node_wait'::text) AND (resume_at IS NOT NULL) AND (retry_due_at IS NULL)) OR (((wait_kind)::text = 'retry_backoff'::text) AND (resume_at IS NULL) AND (retry_due_at IS NOT NULL)))) OR (((status)::text <> 'waiting'::text) AND (control_kind IS NULL) AND (wait_kind IS NULL) AND (resume_at IS NULL) AND (retry_due_at IS NULL))) IS TRUE));--> statement-breakpoint
ALTER TABLE "app"."workflow_runs" ADD CONSTRAINT "workflow_runs_human_wait_valid" CHECK (((human_wait_started_at IS NULL AND remaining_execution_ms IS NULL)
      OR (human_wait_started_at IS NOT NULL AND (remaining_execution_ms IS NULL OR (remaining_execution_ms > 0 AND remaining_execution_ms <= 3600000)) AND status IN ('waiting','succeeded','failed','canceled','timed_out','outcome_unknown') AND deadline_at IS NOT DISTINCT FROM absolute_deadline_at)) IS TRUE);
--> statement-breakpoint
ALTER TABLE app.pending_run_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.pending_run_tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY pending_run_tasks_workspace_scope ON app.pending_run_tasks TO {{app_role}}
  USING (workspace_id::text = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK (workspace_id::text = NULLIF(current_setting('app.workspace_id', true), ''));
CREATE POLICY pending_run_tasks_owner ON app.pending_run_tasks TO {{owner_role}} USING (true) WITH CHECK (true);
CREATE POLICY pending_run_tasks_maintenance ON app.pending_run_tasks TO {{maintenance_role}} USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON app.pending_run_tasks TO {{app_role}};
GRANT UPDATE (status, output_ref, decided_by, completed_at, consumed_at) ON app.pending_run_tasks TO {{app_role}};
GRANT SELECT, DELETE ON app.pending_run_tasks TO {{maintenance_role}};
GRANT UPDATE (deadline_at) ON app.workflow_calls TO {{app_role}};
GRANT UPDATE (deadline_at, human_wait_started_at, remaining_execution_ms) ON app.workflow_runs TO {{app_role}};

-- Callers already hold their run/checkpoint. Do not reverse that lock order.
CREATE FUNCTION app.lock_workspace_execution_counter(p_workspace uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog','app','pg_temp'
  SET row_security TO 'on' AS $$
BEGIN
  IF nullif(current_setting('app.workspace_id',true),'')::uuid IS DISTINCT FROM p_workspace THEN
    RAISE EXCEPTION 'workspace context mismatch' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM app.workspace_execution_admission_counters WHERE workspace_id=p_workspace FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'workspace admission state missing' USING ERRCODE='PTA01'; END IF;
END $$;
REVOKE ALL ON FUNCTION app.lock_workspace_execution_counter(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lock_workspace_execution_counter(uuid) TO {{app_role}}, {{maintenance_role}};
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
END $$;

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
  IF NEW.status IN ('running','waiting') AND NEW.human_wait_started_at IS NULL THEN
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
      (TG_OP='UPDATE' AND (OLD.status NOT IN ('running','waiting') OR OLD.human_wait_started_at IS NOT NULL)
       AND NEW.status IN ('running','waiting') AND NEW.human_wait_started_at IS NULL)) AND
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
END $$;

CREATE OR REPLACE FUNCTION app.workflow_concurrency_admissible(p_workspace uuid, p_run uuid, p_grant boolean) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE v_run app.workflow_runs%ROWTYPE; v_limit integer; v_reserved boolean; v_exempt boolean;
BEGIN
  IF nullif(current_setting('app.workspace_id',true),'')::uuid IS DISTINCT FROM p_workspace THEN
    RAISE EXCEPTION 'workspace context mismatch' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_run FROM app.workflow_runs WHERE workspace_id=p_workspace AND id=p_run;
  IF NOT FOUND THEN RETURN false; END IF;
  IF v_run.status<>'queued' AND v_run.human_wait_started_at IS NULL THEN RETURN true; END IF;
  SELECT active_run_limit INTO v_limit FROM app.workflow_concurrency_policies
    WHERE workspace_id=p_workspace AND workflow_id=v_run.workflow_id;
  IF v_limit IS NULL THEN RETURN true; END IF;
  IF current_setting('app.workflow_concurrency_protocol',true) IS DISTINCT FROM '1' THEN
    IF p_grant THEN RETURN false; END IF;
    RAISE EXCEPTION 'workflow concurrency protocol required' USING ERRCODE='PTC01';
  END IF;
  SELECT true,workflow_concurrency_order_exempt INTO v_reserved,v_exempt
    FROM app.workflow_run_active_admissions WHERE workspace_id=p_workspace AND workflow_run_id=p_run;
  -- A committed slot survives lowering/enabling; an order-exempt slot predates
  -- ordered grants. Controls cannot use this predicate to start node work.
  IF v_reserved AND v_run.human_wait_started_at IS NULL AND (p_grant OR v_exempt) THEN RETURN true; END IF;
  IF (NOT coalesce(v_reserved,false) OR v_run.human_wait_started_at IS NOT NULL) AND
    (SELECT active_runs+reserved_active_slots
      FROM app.workflow_run_slot_counts(p_workspace,v_run.workflow_id))>=v_limit THEN
    RETURN false;
  END IF;
  RETURN NOT EXISTS(SELECT 1 FROM app.workflow_runs earlier
    WHERE earlier.workspace_id=p_workspace AND earlier.workflow_id=v_run.workflow_id
      AND earlier.status='queued' AND earlier.admission_ticket<v_run.admission_ticket
      AND earlier.cancel_requested_at IS NULL AND (earlier.deadline_at IS NULL OR earlier.deadline_at>clock_timestamp())
      AND NOT EXISTS(SELECT 1 FROM app.workflow_run_active_admissions admission
        WHERE admission.workspace_id=p_workspace AND admission.workflow_run_id=earlier.id
          AND (p_grant OR admission.workflow_concurrency_order_exempt)));
END $$;

CREATE OR REPLACE FUNCTION app.workflow_run_active_capacity_available(p_workspace_id uuid, p_entitlement_version integer, p_workflow_run_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
DECLARE active_limit integer; active_count integer; reserved_count integer; workspace_status text;
BEGIN
  IF nullif(current_setting('app.workspace_id',true),'')::uuid IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'workspace context mismatch' USING ERRCODE='42501';
  END IF;
  -- Protocol rejection precedes the counter, including for old lock-owning workers.
  IF NOT app.workflow_concurrency_admissible(p_workspace_id,p_workflow_run_id,false) THEN RETURN false; END IF;
  SELECT version.active_run_limit INTO active_limit
    FROM app.workspace_execution_admission_counters counter
    JOIN app.workspace_execution_entitlement_versions version ON version.workspace_id=counter.workspace_id
      AND version.version=p_entitlement_version
    WHERE counter.workspace_id=p_workspace_id FOR UPDATE OF counter;
  IF NOT FOUND THEN RAISE EXCEPTION 'workspace admission state missing' USING ERRCODE='PTA01'; END IF;
  IF NOT app.workflow_concurrency_admissible(p_workspace_id,p_workflow_run_id,false) THEN RETURN false; END IF;
  SELECT active_runs,reserved_active_slots INTO active_count,reserved_count
    FROM app.workflow_run_slot_counts(p_workspace_id,NULL,p_workflow_run_id);
  SELECT status INTO workspace_status FROM app.workspaces WHERE id=p_workspace_id;
  RETURN workspace_status='active' AND (
    EXISTS(SELECT 1 FROM app.workflow_run_active_admissions admission
      WHERE admission.workspace_id=p_workspace_id AND admission.workflow_run_id=p_workflow_run_id
        AND admission.borrowed_call_id IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM app.workflow_runs paused WHERE paused.workspace_id=p_workspace_id AND paused.id=p_workflow_run_id AND paused.human_wait_started_at IS NOT NULL))
    OR EXISTS(SELECT 1 FROM app.workflow_calls loan WHERE loan.workspace_id=p_workspace_id AND loan.parent_run_id=p_workflow_run_id AND loan.slot_lent)
    OR active_count+reserved_count<active_limit);
END $$;

CREATE OR REPLACE FUNCTION app.return_workflow_run_slot(
  p_workspace uuid, p_call uuid, p_parent_outbox uuid
) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'pg_catalog', 'app'
  SET row_security TO 'on'
AS $$
DECLARE v_parent app.workflow_runs%ROWTYPE; v_call app.workflow_calls%ROWTYPE; v_incoming uuid; v_owner uuid;
BEGIN
  IF nullif(current_setting('app.workspace_id',true),'')::uuid IS DISTINCT FROM p_workspace THEN
    RAISE EXCEPTION 'workspace context mismatch' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM app.workspaces WHERE id=p_workspace FOR KEY SHARE;
  SELECT * INTO v_call FROM app.workflow_calls WHERE workspace_id=p_workspace AND id=p_call;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO v_parent FROM app.workflow_runs
    WHERE workspace_id=p_workspace AND id=v_call.parent_run_id FOR NO KEY UPDATE;
  SELECT * INTO v_call FROM app.workflow_calls
    WHERE workspace_id=p_workspace AND id=p_call FOR NO KEY UPDATE;
  IF NOT v_call.slot_lent THEN RETURN false; END IF;
  PERFORM 1 FROM app.outbox_events WHERE workspace_id=p_workspace AND id=p_parent_outbox
    AND aggregate_id=v_call.parent_run_id AND aggregate_type='workflow-run' AND job_name='advance-workflow-run' FOR KEY SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT id INTO v_incoming FROM app.workflow_calls
    WHERE workspace_id=p_workspace AND child_run_id=v_call.parent_run_id AND slot_lent;
  IF v_incoming IS NOT NULL THEN
    PERFORM 1 FROM app.workflow_calls WHERE workspace_id=p_workspace AND id=v_incoming FOR KEY SHARE;
  END IF;
  SELECT workflow_run_id INTO v_owner FROM app.workflow_run_active_admissions
    WHERE workspace_id=p_workspace AND workflow_run_id=v_call.child_run_id AND borrowed_call_id=p_call FOR UPDATE;
  -- A nested borrower still owning the slot must return it one level first.
  IF v_owner IS NULL THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM app.workflow_runs WHERE workspace_id=p_workspace AND id=v_owner
    AND status IN ('queued','running','waiting')) THEN RETURN false; END IF;
  PERFORM 1 FROM app.workspace_execution_admission_counters WHERE workspace_id=p_workspace FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'workspace admission state missing' USING ERRCODE='PTA01'; END IF;
  -- A child that ended while suspended no longer owns a workspace slot.
  -- A live, resumed parent must compete for fresh capacity before its loan ends.
  IF v_parent.status IN ('running','waiting') AND v_parent.human_wait_started_at IS NULL
     AND EXISTS(SELECT 1 FROM app.workflow_runs child WHERE child.workspace_id=p_workspace AND child.id=v_owner AND child.human_wait_started_at IS NOT NULL)
     AND (SELECT active_runs+reserved_active_slots FROM app.workflow_run_slot_counts(p_workspace)) >=
       (SELECT active_run_limit FROM app.workspace_execution_entitlement_versions WHERE workspace_id=p_workspace AND version=v_parent.execution_entitlement_version)
  THEN RETURN false; END IF;
  UPDATE app.workflow_calls SET slot_lent=false WHERE workspace_id=p_workspace AND id=p_call;
  IF v_incoming IS NULL THEN
    DELETE FROM app.workflow_run_active_admissions
      WHERE workspace_id=p_workspace AND workflow_run_id=v_owner AND borrowed_call_id=p_call;
  ELSE
    UPDATE app.workflow_run_active_admissions
      SET workflow_run_id=v_call.parent_run_id,outbox_event_id=p_parent_outbox,borrowed_call_id=v_incoming,
        workflow_concurrency_order_exempt=true,recover_after=clock_timestamp()+interval '5 minutes'
      WHERE workspace_id=p_workspace AND workflow_run_id=v_owner AND borrowed_call_id=p_call;
  END IF;
  UPDATE app.workspace_execution_admission_counters counter
    SET active_runs=counts.active_runs,queued_runs=counts.queued_runs,reconciled_at=clock_timestamp()
    FROM app.workflow_run_slot_counts(p_workspace) counts WHERE counter.workspace_id=p_workspace;
  RETURN true;
END $$;

DROP TRIGGER workflow_runs_execution_admission ON app.workflow_runs;
CREATE TRIGGER workflow_runs_execution_admission BEFORE INSERT OR UPDATE OF workspace_id,status,execution_entitlement_version,human_wait_started_at ON app.workflow_runs
  FOR EACH ROW EXECUTE FUNCTION app.enforce_workflow_run_admission();
DROP TRIGGER workflow_runs_refresh_execution_admission ON app.workflow_runs;
CREATE TRIGGER workflow_runs_refresh_execution_admission AFTER INSERT OR UPDATE OF workspace_id,status,execution_entitlement_version,human_wait_started_at ON app.workflow_runs
  FOR EACH ROW EXECUTE FUNCTION app.refresh_workflow_run_admission_counters();
