CREATE INDEX "preview_runs_unfinished_deadline_idx" ON "app"."preview_runs" USING btree ("execution_deadline_at","id") WHERE "app"."preview_runs"."status" in ('queued','running');
--> statement-breakpoint
-- Maintenance already reads/reaps previews. Core now decides unclaimed expiry;
-- these columns persist its terminal decision, without granting provider dispatch.
GRANT UPDATE(status,safe_error_code,error_summary,started_at,completed_at,
  lease_owner,lease_expires_at,fence_token,updated_at)
  ON app.preview_attempts TO {{maintenance_role}};
--> statement-breakpoint
GRANT UPDATE(status,safe_error_code,started_at,completed_at,updated_at)
  ON app.preview_runs TO {{maintenance_role}};
--> statement-breakpoint
GRANT INSERT(id,workspace_id,category,quantity,resource_type,resource_id,idempotency_key,metadata,occurred_at)
  ON app.usage_events TO {{maintenance_role}};
