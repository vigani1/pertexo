ALTER TABLE "app"."pending_run_tasks" DROP CONSTRAINT "pending_run_tasks_state_valid";--> statement-breakpoint
ALTER TABLE "app"."pending_run_tasks" ADD CONSTRAINT "pending_run_tasks_state_valid" CHECK (((kind='callback' AND status='prepared' AND node_run_id IS NULL AND opened_at IS NULL AND output_ref IS NULL AND decided_by IS NULL AND completed_at IS NULL AND consumed_at IS NULL)
    OR (status = 'pending' AND output_ref IS NULL AND decided_by IS NULL AND completed_at IS NULL AND consumed_at IS NULL)
    OR (status IN ('approved','rejected','submitted') AND output_ref IS NOT NULL AND ((kind='callback' AND decided_by IS NULL) OR (kind<>'callback' AND decided_by IS NOT NULL)) AND completed_at IS NOT NULL)
    OR (status = 'expired' AND kind IN ('approval','input_request') AND output_ref IS NOT NULL AND decided_by IS NULL AND completed_at IS NOT NULL)
    OR (status IN ('expired','refused','canceled') AND output_ref IS NULL AND decided_by IS NULL AND completed_at IS NOT NULL)) IS TRUE);