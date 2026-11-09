ALTER TABLE "app"."preview_attempts" DROP CONSTRAINT "preview_attempts_output_bounded";--> statement-breakpoint
ALTER TABLE "app"."preview_runs" DROP CONSTRAINT "preview_runs_input_bounded";--> statement-breakpoint
ALTER TABLE "app"."preview_runs" DROP CONSTRAINT "preview_runs_node_bounded";--> statement-breakpoint
ALTER TABLE "app"."preview_runs" DROP CONSTRAINT "preview_runs_output_bounded";--> statement-breakpoint
ALTER TABLE "app"."node_attempts" DROP CONSTRAINT "node_attempts_output_ref_bounded";--> statement-breakpoint
ALTER TABLE "app"."node_runs" DROP CONSTRAINT "node_runs_input_ref_bounded";--> statement-breakpoint
ALTER TABLE "app"."node_runs" DROP CONSTRAINT "node_runs_output_ref_bounded";--> statement-breakpoint
ALTER TABLE "app"."pending_run_tasks" DROP CONSTRAINT "pending_run_tasks_output_bounded";--> statement-breakpoint
ALTER TABLE "app"."workflow_runs" DROP CONSTRAINT "workflow_runs_input_ref_bounded";--> statement-breakpoint
ALTER TABLE "app"."workflow_runs" DROP CONSTRAINT "workflow_runs_output_ref_bounded";
--> statement-breakpoint
-- Preserve the storage limits without detoasting untouched values on status updates.
CREATE FUNCTION app.check_execution_value_bytes() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'pg_catalog'
AS $$
DECLARE value_bytes integer;
BEGIN
  EXECUTE format('SELECT octet_length(($1).%I::text)', TG_ARGV[0])
    INTO value_bytes USING NEW;
  IF value_bytes > TG_ARGV[1]::integer THEN
    RAISE EXCEPTION 'execution value exceeds stored byte limit'
      USING ERRCODE='23514', CONSTRAINT=TG_ARGV[2],
        TABLE=TG_TABLE_NAME, SCHEMA=TG_TABLE_SCHEMA;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.check_execution_value_bytes() FROM PUBLIC;

--> statement-breakpoint
CREATE TRIGGER workflow_runs_input_ref_bytes BEFORE INSERT OR UPDATE OF input_ref ON app.workflow_runs
FOR EACH ROW EXECUTE FUNCTION app.check_execution_value_bytes('input_ref','4194304','workflow_runs_input_ref_bounded');

--> statement-breakpoint
CREATE TRIGGER workflow_runs_output_ref_bytes BEFORE INSERT OR UPDATE OF output_ref ON app.workflow_runs
FOR EACH ROW EXECUTE FUNCTION app.check_execution_value_bytes('output_ref','4194304','workflow_runs_output_ref_bounded');

--> statement-breakpoint
CREATE TRIGGER node_runs_input_ref_bytes BEFORE INSERT OR UPDATE OF input_ref ON app.node_runs
FOR EACH ROW EXECUTE FUNCTION app.check_execution_value_bytes('input_ref','4194304','node_runs_input_ref_bounded');

--> statement-breakpoint
CREATE TRIGGER node_runs_output_ref_bytes BEFORE INSERT OR UPDATE OF output_ref ON app.node_runs
FOR EACH ROW EXECUTE FUNCTION app.check_execution_value_bytes('output_ref','4194304','node_runs_output_ref_bounded');

--> statement-breakpoint
CREATE TRIGGER node_attempts_output_ref_bytes BEFORE INSERT OR UPDATE OF output_ref ON app.node_attempts
FOR EACH ROW EXECUTE FUNCTION app.check_execution_value_bytes('output_ref','4194304','node_attempts_output_ref_bounded');

--> statement-breakpoint
CREATE TRIGGER preview_runs_input_ref_bytes BEFORE INSERT OR UPDATE OF input_ref ON app.preview_runs
FOR EACH ROW EXECUTE FUNCTION app.check_execution_value_bytes('input_ref','4194304','preview_runs_input_bounded');

--> statement-breakpoint
CREATE TRIGGER preview_runs_output_ref_bytes BEFORE INSERT OR UPDATE OF output_ref ON app.preview_runs
FOR EACH ROW EXECUTE FUNCTION app.check_execution_value_bytes('output_ref','4194304','preview_runs_output_bounded');

--> statement-breakpoint
CREATE TRIGGER preview_runs_executable_node_json_bytes BEFORE INSERT OR UPDATE OF executable_node_json ON app.preview_runs
FOR EACH ROW EXECUTE FUNCTION app.check_execution_value_bytes('executable_node_json','2097152','preview_runs_node_bounded');

--> statement-breakpoint
CREATE TRIGGER preview_attempts_output_ref_bytes BEFORE INSERT OR UPDATE OF output_ref ON app.preview_attempts
FOR EACH ROW EXECUTE FUNCTION app.check_execution_value_bytes('output_ref','4194304','preview_attempts_output_bounded');

--> statement-breakpoint
CREATE TRIGGER pending_run_tasks_output_ref_bytes BEFORE INSERT OR UPDATE OF output_ref ON app.pending_run_tasks
FOR EACH ROW EXECUTE FUNCTION app.check_execution_value_bytes('output_ref','4194304','pending_run_tasks_output_bounded');
