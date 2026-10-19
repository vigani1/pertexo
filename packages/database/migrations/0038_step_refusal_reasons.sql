ALTER TABLE "app"."preview_attempts" ADD COLUMN "error_summary" varchar(2048);--> statement-breakpoint
GRANT UPDATE(error_summary) ON app.preview_attempts TO {{app_role}};
