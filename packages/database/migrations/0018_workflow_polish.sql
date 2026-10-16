ALTER TABLE "app"."run_error_workflow_intents" DROP CONSTRAINT "run_error_workflow_intents_state_valid";--> statement-breakpoint
ALTER TABLE "app"."run_error_workflow_intents" ALTER COLUMN "target_version_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."run_error_workflow_intents" ALTER COLUMN "outbox_event_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."run_error_workflow_intents" ADD CONSTRAINT "run_error_workflow_intents_target_valid" CHECK ((CASE WHEN refusal_code = 'target_not_published' THEN status = 'refused' AND target_version_id IS NULL AND outbox_event_id IS NULL ELSE target_version_id IS NOT NULL AND outbox_event_id IS NOT NULL END) IS TRUE);--> statement-breakpoint
ALTER TABLE "app"."run_error_workflow_intents" ADD CONSTRAINT "run_error_workflow_intents_state_valid" CHECK (((status = 'pending' AND accepted_run_id IS NULL AND refusal_code IS NULL AND completed_at IS NULL) OR (status = 'accepted' AND accepted_run_id IS NOT NULL AND refusal_code IS NULL AND completed_at IS NOT NULL) OR (status = 'refused' AND accepted_run_id IS NULL AND refusal_code IN ('target_unavailable','workspace_unavailable','queue_full','invalid_target','target_not_published') AND completed_at IS NOT NULL)) IS TRUE);--> statement-breakpoint
GRANT UPDATE(available_at,updated_at) ON app.outbox_events TO {{app_role}};
--> statement-breakpoint
CREATE POLICY outbox_events_error_workflow_wakeup ON app.outbox_events FOR UPDATE TO {{app_role}}
  USING (workspace_id::text = nullif(current_setting('app.workspace_id',true),'') AND job_name='start-error-workflow' AND published_at IS NULL AND failed_at IS NULL)
  WITH CHECK (workspace_id::text = nullif(current_setting('app.workspace_id',true),'') AND job_name='start-error-workflow' AND published_at IS NULL AND failed_at IS NULL);
