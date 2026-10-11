ALTER TABLE "app"."node_runs" DROP CONSTRAINT "node_runs_control_kind_valid";--> statement-breakpoint
ALTER TABLE "app"."node_runs" DROP CONSTRAINT "node_runs_wait_state_valid";--> statement-breakpoint
ALTER TABLE "app"."workflow_runs" DROP CONSTRAINT "workflow_runs_trigger_type_valid";--> statement-breakpoint
ALTER TABLE "app"."node_runs" ADD CONSTRAINT "node_runs_control_kind_valid" CHECK (((control_kind IS NULL) OR ((control_kind)::text IN ('for_each_barrier'::text, 'workflow_call'::text))));--> statement-breakpoint
ALTER TABLE "app"."node_runs" ADD CONSTRAINT "node_runs_wait_state_valid" CHECK ((((((status)::text = 'waiting'::text) AND ((control_kind)::text IN ('for_each_barrier'::text, 'workflow_call'::text)) AND (wait_kind IS NULL) AND (resume_at IS NULL) AND (retry_due_at IS NULL)) OR (((status)::text = 'waiting'::text) AND (control_kind IS NULL) AND ((((wait_kind)::text = 'node_wait'::text) AND (resume_at IS NOT NULL) AND (retry_due_at IS NULL)) OR (((wait_kind)::text = 'retry_backoff'::text) AND (resume_at IS NULL) AND (retry_due_at IS NOT NULL)))) OR (((status)::text <> 'waiting'::text) AND (control_kind IS NULL) AND (wait_kind IS NULL) AND (resume_at IS NULL) AND (retry_due_at IS NULL))) IS TRUE));--> statement-breakpoint
ALTER TABLE "app"."workflow_runs" ADD CONSTRAINT "workflow_runs_trigger_type_valid" CHECK (((trigger_type)::text = ANY (ARRAY[('api'::character varying)::text, ('manual'::character varying)::text, ('replay'::character varying)::text, ('schedule'::character varying)::text, ('webhook'::character varying)::text, ('workflow_call'::character varying)::text])));
--> statement-breakpoint
-- Every run writer pins workspace/entitlement rows before locking a run; the
-- capacity counter stays last in insertion and slot transfer.
CREATE OR REPLACE FUNCTION app.lock_workspace_run_admission(p_workspace_id uuid) RETURNS character varying
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE workspace_status varchar;
BEGIN
  IF p_workspace_id::text IS DISTINCT FROM
    nullif(current_setting('app.workspace_id',true),'') THEN
    RAISE EXCEPTION 'workspace context mismatch' USING ERRCODE='42501';
  END IF;
  SELECT status INTO workspace_status FROM app.workspaces
   WHERE id=p_workspace_id FOR SHARE;
  PERFORM 1 FROM app.workspace_execution_entitlements current
    JOIN app.workspace_execution_entitlement_versions version
      ON version.workspace_id=current.workspace_id AND version.version=current.current_version
    WHERE current.workspace_id=p_workspace_id FOR SHARE OF current,version;
  RETURN workspace_status;
END $$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.lock_workspace_run_admission(uuid),
  app.lock_workflow_run_replay_version(uuid,uuid,uuid) TO {{maintenance_role}};
--> statement-breakpoint
-- Shared acceptance and direct child cancellation use existing maintenance
-- authority. Immutable workflow versions remain read-only.
GRANT INSERT ON app.workflow_runs, app.run_checkpoints, app.idempotency_records TO {{maintenance_role}};
GRANT UPDATE(status,result_ref,updated_at) ON app.idempotency_records TO {{maintenance_role}};
GRANT UPDATE(destination_id) ON app.workflow_failure_notification_policies TO {{maintenance_role}};
GRANT UPDATE(status) ON app.failure_notification_destinations, app.connections TO {{maintenance_role}};

--> statement-breakpoint
GRANT INSERT ON app.transport_security_audit_facts TO {{maintenance_role}};
