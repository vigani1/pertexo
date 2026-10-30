ALTER TABLE "app"."form_uploads" ADD COLUMN "submitted_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "form_uploads_unsent_public_idx" ON "app"."form_uploads" USING btree ("workspace_id") WHERE capability_hash IS NOT NULL AND submitted_at IS NULL;
--> statement-breakpoint
GRANT UPDATE (submitted_at) ON app.form_uploads TO {{app_role}};
