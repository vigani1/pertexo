ALTER TABLE "app"."workflow_forms" ADD COLUMN "sealed_capability" jsonb;--> statement-breakpoint
ALTER TABLE "app"."workflow_forms" ADD CONSTRAINT "workflow_forms_sealed_capability_valid" CHECK (sealed_capability IS NULL OR capability_hash IS NOT NULL);
--> statement-breakpoint
GRANT UPDATE(sealed_capability) ON app.workflow_forms TO {{app_role}};
