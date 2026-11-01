ALTER TABLE "app"."run_failure_notification_intents" ADD COLUMN "dispatched_config_version" integer;--> statement-breakpoint
ALTER TABLE "app"."run_failure_notification_intents" ADD COLUMN "dispatched_secret_version_id" uuid;--> statement-breakpoint
GRANT UPDATE(dispatched_config_version,dispatched_secret_version_id) ON TABLE app.run_failure_notification_intents TO {{app_role}};
