-- Run admission checks queue heads, not the whole backlog (architecture-07).
-- The slot rules move into two counting functions that never count queued runs,
-- so an admission check costs the same with 10 or 10,000 runs waiting.

CREATE FUNCTION app.workflow_run_active_slots(p_workspace uuid, p_workflow uuid, p_excluded_run uuid) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
BEGIN
  IF nullif(current_setting('app.workspace_id',true),'')::uuid IS DISTINCT FROM p_workspace THEN
    RAISE EXCEPTION 'workspace context mismatch' USING ERRCODE='42501';
  END IF;
  RETURN (SELECT count(*)::integer FROM app.workflow_runs run
    WHERE run.workspace_id=p_workspace AND run.status IN ('running','waiting') AND run.human_wait_started_at IS NULL
      -- A timed Wait holds no workspace slot, but keeps its place in the workflow's own limit.
      AND (p_workflow IS NOT NULL OR run.timed_wait_started_at IS NULL)
      AND (p_workflow IS NULL OR run.workflow_id=p_workflow)
      AND (p_excluded_run IS NULL OR run.id<>p_excluded_run)
      AND (p_workflow IS NOT NULL OR NOT EXISTS (
        SELECT 1 FROM app.workflow_calls call WHERE call.workspace_id=p_workspace
          AND call.parent_run_id=run.id AND call.slot_lent)));
END $$;

ALTER FUNCTION app.workflow_run_active_slots(p_workspace uuid, p_workflow uuid, p_excluded_run uuid) OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.workflow_run_active_slots(p_workspace uuid, p_workflow uuid, p_excluded_run uuid) FROM PUBLIC;

CREATE FUNCTION app.workflow_run_reserved_slots(p_workspace uuid, p_workflow uuid, p_excluded_run uuid) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
BEGIN
  IF nullif(current_setting('app.workspace_id',true),'')::uuid IS DISTINCT FROM p_workspace THEN
    RAISE EXCEPTION 'workspace context mismatch' USING ERRCODE='42501';
  END IF;
  RETURN (SELECT count(*)::integer FROM app.workflow_run_active_admissions admission
    JOIN app.workflow_runs run
      ON run.workspace_id=admission.workspace_id AND run.id=admission.workflow_run_id
    WHERE admission.workspace_id=p_workspace AND run.human_wait_started_at IS NULL AND run.status NOT IN ('running','waiting')
      AND (p_workflow IS NULL OR (run.workflow_id=p_workflow AND run.status='queued'))
      AND (p_excluded_run IS NULL OR run.id<>p_excluded_run));
END $$;

ALTER FUNCTION app.workflow_run_reserved_slots(p_workspace uuid, p_workflow uuid, p_excluded_run uuid) OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.workflow_run_reserved_slots(p_workspace uuid, p_workflow uuid, p_excluded_run uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.workflow_run_slot_counts(p_workspace uuid, p_workflow uuid DEFAULT NULL::uuid, p_excluded_run uuid DEFAULT NULL::uuid) RETURNS TABLE(active_runs integer, reserved_active_slots integer, queued_runs integer)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
BEGIN
  IF nullif(current_setting('app.workspace_id',true),'')::uuid IS DISTINCT FROM p_workspace THEN
    RAISE EXCEPTION 'workspace context mismatch' USING ERRCODE='42501';
  END IF;
  RETURN QUERY SELECT
    app.workflow_run_active_slots(p_workspace,p_workflow,p_excluded_run),
    app.workflow_run_reserved_slots(p_workspace,p_workflow,p_excluded_run),
    (SELECT count(*)::integer FROM app.workflow_runs run
      WHERE run.workspace_id=p_workspace AND run.status='queued'
        AND (p_workflow IS NULL OR run.workflow_id=p_workflow)
        AND (p_excluded_run IS NULL OR run.id<>p_excluded_run));
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
    app.workflow_run_active_slots(p_workspace,v_run.workflow_id,NULL)
      +app.workflow_run_reserved_slots(p_workspace,v_run.workflow_id,NULL)>=v_limit THEN
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

CREATE OR REPLACE FUNCTION app.workflow_run_active_admission_eligible(p_workspace_id uuid, p_outbox_event_id uuid, p_workflow_run_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
DECLARE v_run app.workflow_runs%ROWTYPE; v_prior text; v_status text; v_limit integer; v_result boolean:=false;
BEGIN
  v_prior:=current_setting('app.workspace_id',true);
  PERFORM set_config('app.workspace_id',p_workspace_id::text,true);
  SELECT run.* INTO v_run FROM app.workflow_runs run JOIN app.outbox_events event
    ON event.id=p_outbox_event_id AND event.workspace_id=run.workspace_id
      AND event.aggregate_type='workflow-run' AND event.aggregate_id=run.id AND event.job_name='advance-workflow-run'
    WHERE run.workspace_id=p_workspace_id AND run.id=p_workflow_run_id;
  IF FOUND THEN
    IF v_run.status<>'queued' OR v_run.cancel_requested_at IS NOT NULL OR v_run.deadline_at<=clock_timestamp() THEN
      v_result:=true;
    ELSE
      SELECT status INTO v_status FROM app.workspaces WHERE id=p_workspace_id;
      SELECT active_run_limit INTO v_limit FROM app.workspace_execution_entitlement_versions
        WHERE workspace_id=p_workspace_id AND version=v_run.execution_entitlement_version;
      v_result:=v_status='active' AND app.workflow_concurrency_admissible(p_workspace_id,p_workflow_run_id,true)
        AND (EXISTS(SELECT 1 FROM app.workflow_run_active_admissions WHERE workspace_id=p_workspace_id
          AND workflow_run_id=p_workflow_run_id AND outbox_event_id=p_outbox_event_id)
        OR (NOT EXISTS(SELECT 1 FROM app.workflow_run_active_admissions WHERE workspace_id=p_workspace_id AND workflow_run_id=p_workflow_run_id)
          AND app.workflow_run_active_slots(p_workspace_id,NULL,NULL)
            +app.workflow_run_reserved_slots(p_workspace_id,NULL,NULL)<v_limit));
    END IF;
  END IF;
  PERFORM set_config('app.workspace_id',coalesce(v_prior,''),true); RETURN coalesce(v_result,false);
EXCEPTION WHEN OTHERS THEN PERFORM set_config('app.workspace_id',coalesce(v_prior,''),true); RAISE;
END $$;

CREATE OR REPLACE FUNCTION app.workflow_run_active_capacity_available(p_workspace_id uuid, p_entitlement_version integer, p_workflow_run_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
DECLARE active_limit integer;
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
  RETURN (
    EXISTS(SELECT 1 FROM app.workflow_run_active_admissions admission
      WHERE admission.workspace_id=p_workspace_id AND admission.workflow_run_id=p_workflow_run_id
        AND admission.borrowed_call_id IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM app.workflow_runs paused WHERE paused.workspace_id=p_workspace_id AND paused.id=p_workflow_run_id AND paused.human_wait_started_at IS NOT NULL))
    OR EXISTS(SELECT 1 FROM app.workflow_calls loan WHERE loan.workspace_id=p_workspace_id AND loan.parent_run_id=p_workflow_run_id AND loan.slot_lent)
    OR app.workflow_run_active_slots(p_workspace_id,NULL,p_workflow_run_id)
      +app.workflow_run_reserved_slots(p_workspace_id,NULL,p_workflow_run_id)<active_limit);
END $$;

-- The claim skips these deliveries without checking them one by one. A queued
-- run can only be admitted at the head of its workflow's limited queue, or into
-- one of the workspace's free slots, so the rest wait for a later claim.
CREATE FUNCTION app.held_workflow_run_admission_events(p_workspace uuid) RETURNS SETOF uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
DECLARE v_prior text;
BEGIN
  v_prior:=current_setting('app.workspace_id',true);
  PERFORM set_config('app.workspace_id',p_workspace::text,true);
  RETURN QUERY
  WITH waiting AS MATERIALIZED (
    SELECT event.id AS event_id, run.workflow_id, run.admission_ticket, run.execution_entitlement_version,
      event.available_at<=clock_timestamp()
        AND (event.lease_expires_at IS NULL OR event.lease_expires_at<=clock_timestamp()) AS claimable,
      EXISTS(SELECT 1 FROM app.workflow_concurrency_policies policy
        WHERE policy.workspace_id=p_workspace AND policy.workflow_id=run.workflow_id
          AND policy.active_run_limit IS NOT NULL) AS limited,
      event.available_at
    FROM app.outbox_events event
    JOIN app.workflow_runs run ON run.workspace_id=event.workspace_id AND run.id=event.aggregate_id
    WHERE event.workspace_id=p_workspace AND event.job_name='advance-workflow-run'
      AND event.aggregate_type='workflow-run' AND event.published_at IS NULL AND event.failed_at IS NULL
      AND run.status='queued' AND run.cancel_requested_at IS NULL
      AND (run.deadline_at IS NULL OR run.deadline_at>clock_timestamp())
      AND NOT EXISTS(SELECT 1 FROM app.workflow_run_active_admissions admission
        WHERE admission.workspace_id=p_workspace AND admission.workflow_run_id=run.id)
  ), free AS (
    -- The maintained counter, not a count of the backlog. An estimate is enough:
    -- every candidate is still checked exactly, under the counter lock.
    SELECT greatest(0,
      coalesce((SELECT max(version.active_run_limit) FROM app.workspace_execution_entitlement_versions version
        WHERE version.workspace_id=p_workspace
          AND version.version IN (SELECT waiting.execution_entitlement_version FROM waiting)),0)
      -counter.active_runs-app.workflow_run_reserved_slots(p_workspace,NULL,NULL)) AS slots
    FROM app.workspace_execution_admission_counters counter
    WHERE counter.workspace_id=p_workspace
  ), ranked AS (
    SELECT waiting.event_id,
      CASE WHEN waiting.limited
        THEN waiting.admission_ticket=min(waiting.admission_ticket) OVER (PARTITION BY waiting.workflow_id)
        ELSE waiting.claimable AND row_number() OVER (
          PARTITION BY waiting.limited, waiting.claimable
          ORDER BY waiting.available_at, waiting.event_id)<=free.slots
      END AS candidate
    FROM waiting CROSS JOIN free
  )
  SELECT ranked.event_id FROM ranked WHERE NOT ranked.candidate;
  PERFORM set_config('app.workspace_id',coalesce(v_prior,''),true);
EXCEPTION WHEN OTHERS THEN PERFORM set_config('app.workspace_id',coalesce(v_prior,''),true); RAISE;
END $$;

ALTER FUNCTION app.held_workflow_run_admission_events(p_workspace uuid) OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.held_workflow_run_admission_events(p_workspace uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION app.held_workflow_run_admission_events(p_workspace uuid) TO {{maintenance_role}};
