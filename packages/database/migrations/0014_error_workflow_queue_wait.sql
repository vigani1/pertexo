ALTER TABLE "app"."run_error_workflow_intents" ADD COLUMN "queue_wait_expires_at" timestamp with time zone;
--> statement-breakpoint
GRANT UPDATE (queue_wait_expires_at,outbox_event_id) ON app.run_error_workflow_intents TO {{app_role}};
