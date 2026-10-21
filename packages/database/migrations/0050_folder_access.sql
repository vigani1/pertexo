CREATE TABLE "app"."workflow_folder_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"folder_id" uuid NOT NULL,
	"user_id" uuid,
	"organization_id" uuid,
	"group_id" uuid,
	"access" varchar(16) NOT NULL,
	CONSTRAINT "workflow_folder_grants_member_unique" UNIQUE("workspace_id","folder_id","user_id"),
	CONSTRAINT "workflow_folder_grants_group_unique" UNIQUE("workspace_id","folder_id","organization_id","group_id"),
	CONSTRAINT "workflow_folder_grants_access_valid" CHECK (access in ('viewer','editor')),
	CONSTRAINT "workflow_folder_grants_principal_valid" CHECK ((user_id is not null and organization_id is null and group_id is null) or (user_id is null and organization_id is not null and group_id is not null))
);
--> statement-breakpoint
ALTER TABLE "app"."workflow_folders" ADD COLUMN "access_mode" varchar(16) DEFAULT 'workspace' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."workflow_folder_grants" ADD CONSTRAINT "workflow_folder_grants_folder_fk" FOREIGN KEY ("workspace_id","folder_id") REFERENCES "app"."workflow_folders"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workflow_folder_grants" ADD CONSTRAINT "workflow_folder_grants_member_fk" FOREIGN KEY ("workspace_id","user_id") REFERENCES "app"."workspace_memberships"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workflow_folder_grants" ADD CONSTRAINT "workflow_folder_grants_group_fk" FOREIGN KEY ("organization_id","group_id") REFERENCES "app"."auth_directory_groups"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workflow_folder_grants" ADD CONSTRAINT "workflow_folder_grants_link_fk" FOREIGN KEY ("organization_id","workspace_id") REFERENCES "app"."auth_organization_workspaces"("organization_id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflow_folder_grants_member_idx" ON "app"."workflow_folder_grants" USING btree ("workspace_id","user_id","folder_id");--> statement-breakpoint
CREATE INDEX "workflow_folder_grants_group_idx" ON "app"."workflow_folder_grants" USING btree ("workspace_id","organization_id","group_id","folder_id");--> statement-breakpoint
ALTER TABLE "app"."workflow_folders" ADD CONSTRAINT "workflow_folders_access_mode_valid" CHECK (access_mode in ('workspace','restricted'));
--> statement-breakpoint
ALTER TABLE app.workflow_folder_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_folder_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_folder_grants_workspace_scope ON app.workflow_folder_grants TO {{app_role}}
 USING (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''))
 WITH CHECK (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''));
CREATE POLICY workflow_folder_grants_owner ON app.workflow_folder_grants TO {{owner_role}} USING (true) WITH CHECK (true);
CREATE POLICY workflow_folder_grants_maintenance ON app.workflow_folder_grants TO {{maintenance_role}} USING (true) WITH CHECK (true);
GRANT SELECT,INSERT,UPDATE,DELETE ON app.workflow_folder_grants TO {{app_role}};
GRANT SELECT,DELETE ON app.workflow_folder_grants TO {{maintenance_role}};
--> statement-breakpoint
GRANT UPDATE(access_mode) ON app.workflow_folders TO {{app_role}};
GRANT EXECUTE ON FUNCTION app.jsonb_references_artifact(jsonb,uuid) TO {{app_role}};

GRANT UPDATE(revision) ON app.workflow_folders TO {{maintenance_role}};
