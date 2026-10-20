ALTER TABLE "app"."node_attempts" ADD COLUMN "executor_retry_after_millis" integer;--> statement-breakpoint
ALTER TABLE "app"."node_attempts" ADD CONSTRAINT "node_attempts_executor_retry_after_valid" CHECK (executor_retry_after_millis IS NULL OR (executor_failure_kind IS NOT NULL AND executor_retry_after_millis BETWEEN 0 AND 60000));
--> statement-breakpoint
GRANT UPDATE(executor_retry_after_millis) ON app.node_attempts TO {{app_role}};
