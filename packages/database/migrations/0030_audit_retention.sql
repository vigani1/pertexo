ALTER TABLE "app"."workspaces" ADD COLUMN "audit_retention_days" smallint DEFAULT 365 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."workspaces" ADD COLUMN "governance_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."workspaces" ADD CONSTRAINT "workspaces_audit_retention_valid" CHECK (audit_retention_days between 30 and 2555);--> statement-breakpoint
ALTER TABLE "app"."workspaces" ADD CONSTRAINT "workspaces_governance_revision_positive" CHECK (governance_revision > 0);
--> statement-breakpoint
GRANT UPDATE(audit_retention_days, governance_revision) ON app.workspaces TO {{app_role}};
