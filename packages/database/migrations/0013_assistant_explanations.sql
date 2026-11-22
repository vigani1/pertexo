ALTER TABLE "app"."workspaces" ADD COLUMN "assistant_connection_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."workspaces" ADD COLUMN "assistant_model" varchar(512);--> statement-breakpoint
CREATE INDEX "usage_events_assistant_retention_idx" ON "app"."usage_events" USING btree ("occurred_at","id") WHERE category='assistant.model';--> statement-breakpoint
ALTER TABLE "app"."workspaces" ADD CONSTRAINT "workspaces_assistant_selection_complete" CHECK ((assistant_connection_id IS NULL) = (assistant_model IS NULL));
--> statement-breakpoint
GRANT UPDATE (assistant_connection_id, assistant_model)
  ON app.workspaces TO {{app_role}}, {{maintenance_role}};
