-- ADR 088: step data and graphs keep the key order they were written in.
-- These triggers name the columns, so they are dropped around the type change.
DROP TRIGGER "node_attempts_lock_artifact_references" ON "app"."node_attempts";--> statement-breakpoint
DROP TRIGGER "node_runs_lock_artifact_references" ON "app"."node_runs";--> statement-breakpoint
DROP TRIGGER "workflow_runs_lock_artifact_references" ON "app"."workflow_runs";--> statement-breakpoint
ALTER TABLE "app"."workflow_drafts" DROP CONSTRAINT "workflow_drafts_graph_object";--> statement-breakpoint
ALTER TABLE "app"."workflow_versions" DROP CONSTRAINT "workflow_versions_executable_object";--> statement-breakpoint
ALTER TABLE "app"."workflow_versions" DROP CONSTRAINT "workflow_versions_graph_object";--> statement-breakpoint
ALTER TABLE "app"."preview_runs" DROP CONSTRAINT "preview_runs_node_object";--> statement-breakpoint
ALTER TABLE "app"."workflow_test_snapshots" DROP CONSTRAINT "workflow_test_snapshots_graph_bound";--> statement-breakpoint
ALTER TABLE "app"."workflow_test_snapshots" DROP CONSTRAINT "workflow_test_snapshots_executable_bound";--> statement-breakpoint
ALTER TABLE "app"."workflow_test_snapshots" DROP CONSTRAINT "workflow_test_snapshots_pins_bound";--> statement-breakpoint
ALTER TABLE "app"."workflow_drafts" ALTER COLUMN "graph_json" SET DATA TYPE json;--> statement-breakpoint
ALTER TABLE "app"."workflow_versions" ALTER COLUMN "graph_json" SET DATA TYPE json;--> statement-breakpoint
ALTER TABLE "app"."workflow_versions" ALTER COLUMN "executable_json" SET DATA TYPE json;--> statement-breakpoint
ALTER TABLE "app"."trigger_coordinated_events" ALTER COLUMN "input_ref" SET DATA TYPE json;--> statement-breakpoint
ALTER TABLE "app"."workflow_calls" ALTER COLUMN "input_ref" SET DATA TYPE json;--> statement-breakpoint
ALTER TABLE "app"."workflow_calls" ALTER COLUMN "result_ref" SET DATA TYPE json;--> statement-breakpoint
ALTER TABLE "app"."node_attempts" ALTER COLUMN "output_ref" SET DATA TYPE json;--> statement-breakpoint
ALTER TABLE "app"."node_runs" ALTER COLUMN "input_ref" SET DATA TYPE json;--> statement-breakpoint
ALTER TABLE "app"."node_runs" ALTER COLUMN "output_ref" SET DATA TYPE json;--> statement-breakpoint
ALTER TABLE "app"."node_runs" ALTER COLUMN "failure_ref" SET DATA TYPE json;--> statement-breakpoint
ALTER TABLE "app"."preview_attempts" ALTER COLUMN "output_ref" SET DATA TYPE json;--> statement-breakpoint
ALTER TABLE "app"."preview_runs" ALTER COLUMN "executable_node_json" SET DATA TYPE json;--> statement-breakpoint
ALTER TABLE "app"."preview_runs" ALTER COLUMN "input_ref" SET DATA TYPE json;--> statement-breakpoint
ALTER TABLE "app"."preview_runs" ALTER COLUMN "output_ref" SET DATA TYPE json;--> statement-breakpoint
ALTER TABLE "app"."workflow_runs" ALTER COLUMN "input_ref" SET DATA TYPE json;--> statement-breakpoint
ALTER TABLE "app"."workflow_runs" ALTER COLUMN "output_ref" SET DATA TYPE json;--> statement-breakpoint
ALTER TABLE "app"."operator_run_replay_requests" ALTER COLUMN "run_input" SET DATA TYPE json;--> statement-breakpoint
ALTER TABLE "app"."pending_run_tasks" ALTER COLUMN "output_ref" SET DATA TYPE json;--> statement-breakpoint
ALTER TABLE "app"."workflow_test_snapshots" ALTER COLUMN "graph_json" SET DATA TYPE json;--> statement-breakpoint
ALTER TABLE "app"."workflow_test_snapshots" ALTER COLUMN "executable_json" SET DATA TYPE json;--> statement-breakpoint
ALTER TABLE "app"."workflow_test_snapshots" ALTER COLUMN "pins" SET DATA TYPE json;--> statement-breakpoint
ALTER TABLE "app"."workflow_drafts" ADD CONSTRAINT "workflow_drafts_graph_object" CHECK ((json_typeof(graph_json) = 'object'::text));--> statement-breakpoint
ALTER TABLE "app"."workflow_versions" ADD CONSTRAINT "workflow_versions_executable_object" CHECK (((json_typeof(executable_json) = 'object'::text) AND (octet_length((executable_json)::text) <= 1048576)));--> statement-breakpoint
ALTER TABLE "app"."workflow_versions" ADD CONSTRAINT "workflow_versions_graph_object" CHECK ((json_typeof(graph_json) = 'object'::text));--> statement-breakpoint
ALTER TABLE "app"."preview_runs" ADD CONSTRAINT "preview_runs_node_object" CHECK ((json_typeof(executable_node_json) = 'object'::text));--> statement-breakpoint
ALTER TABLE "app"."workflow_test_snapshots" ADD CONSTRAINT "workflow_test_snapshots_graph_bound" CHECK (json_typeof(graph_json)='object' AND octet_length(graph_json::text)<=2097152);--> statement-breakpoint
ALTER TABLE "app"."workflow_test_snapshots" ADD CONSTRAINT "workflow_test_snapshots_executable_bound" CHECK (json_typeof(executable_json)='object' AND octet_length(executable_json::text)<=2097152);--> statement-breakpoint
ALTER TABLE "app"."workflow_test_snapshots" ADD CONSTRAINT "workflow_test_snapshots_pins_bound" CHECK (json_typeof(pins)='object' AND octet_length(pins::text)<=67108864);--> statement-breakpoint
CREATE TRIGGER "node_attempts_lock_artifact_references" BEFORE INSERT OR UPDATE OF output_ref, reconciliation_ref ON "app"."node_attempts" FOR EACH ROW EXECUTE FUNCTION app.lock_execution_artifact_references();--> statement-breakpoint
CREATE TRIGGER "node_runs_lock_artifact_references" BEFORE INSERT OR UPDATE OF input_ref, output_ref ON "app"."node_runs" FOR EACH ROW EXECUTE FUNCTION app.lock_execution_artifact_references();--> statement-breakpoint
CREATE TRIGGER "workflow_runs_lock_artifact_references" BEFORE INSERT OR UPDATE OF input_ref, output_ref ON "app"."workflow_runs" FOR EACH ROW EXECUTE FUNCTION app.lock_execution_artifact_references();
--> statement-breakpoint
-- Replays read the version's executable as stored, so the function returns json.
DROP FUNCTION app.lock_workflow_run_replay_version(uuid, uuid, uuid);--> statement-breakpoint
CREATE FUNCTION app.lock_workflow_run_replay_version(p_workspace_id uuid, p_workflow_id uuid, p_workflow_version_id uuid) RETURNS TABLE(id uuid, workspace_id uuid, workflow_id uuid, version_number integer, checksum character varying, executable_json json)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
BEGIN
  IF p_workspace_id IS NULL OR p_workflow_id IS NULL
     OR p_workflow_version_id IS NULL THEN
    RAISE EXCEPTION 'workflow replay version lock arguments are invalid'
      USING ERRCODE = '22023';
  END IF;
  IF p_workspace_id::text IS DISTINCT FROM
      NULLIF(current_setting('app.workspace_id', true), '') THEN
    RAISE EXCEPTION 'workflow replay workspace context mismatch'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
    SELECT workflow_version.id,
           workflow_version.workspace_id,
           workflow_version.workflow_id,
           workflow_version.version_number,
           workflow_version.checksum,
           workflow_version.executable_json
      FROM app.workflow_versions AS workflow_version
     WHERE workflow_version.workspace_id = p_workspace_id
       AND workflow_version.workflow_id = p_workflow_id
       AND workflow_version.id = p_workflow_version_id
     FOR SHARE;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app.lock_workflow_run_replay_version(uuid, uuid, uuid) FROM PUBLIC;--> statement-breakpoint
GRANT ALL ON FUNCTION app.lock_workflow_run_replay_version(uuid, uuid, uuid) TO {{app_role}};--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.lock_workflow_run_replay_version(uuid, uuid, uuid) TO {{maintenance_role}};
