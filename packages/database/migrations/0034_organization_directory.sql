CREATE TABLE "app"."auth_provisioning_credentials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"secret_digest" char(64) NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "auth_provisioning_credential_digest_unique" UNIQUE("organization_id","secret_digest"),
	CONSTRAINT "auth_provisioning_credential_name_valid" CHECK (length(btrim(name)) between 1 and 128),
	CONSTRAINT "auth_provisioning_credential_digest_valid" CHECK (secret_digest ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "app"."auth_directory_groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"external_id" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "auth_directory_group_org_identity_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "auth_directory_group_name_valid" CHECK (length(btrim(display_name)) between 1 and 256),
	CONSTRAINT "auth_directory_group_external_valid" CHECK (external_id is null or length(external_id) between 1 and 512),
	CONSTRAINT "auth_directory_group_revision_positive" CHECK (revision>0)
);
--> statement-breakpoint
CREATE TABLE "app"."auth_directory_group_mappings" (
	"organization_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"role" text NOT NULL,
	"priority" integer NOT NULL,
	CONSTRAINT "auth_directory_group_mappings_pkey" PRIMARY KEY("organization_id","workspace_id","group_id"),
	CONSTRAINT "auth_directory_group_mapping_priority_unique" UNIQUE("organization_id","workspace_id","priority"),
	CONSTRAINT "auth_directory_group_mapping_role_valid" CHECK (role in ('viewer','operator','builder','admin')),
	CONSTRAINT "auth_directory_group_mapping_priority_valid" CHECK (priority between 0 and 199)
);
--> statement-breakpoint
CREATE TABLE "app"."auth_directory_group_members" (
	"organization_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"directory_user_id" uuid NOT NULL,
	CONSTRAINT "auth_directory_group_members_pkey" PRIMARY KEY("organization_id","group_id","directory_user_id")
);
--> statement-breakpoint
CREATE TABLE "app"."auth_directory_memberships" (
	"organization_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"directory_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "auth_directory_memberships_pkey" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "app"."auth_directory_users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_name" text NOT NULL,
	"normalized_user_name" text NOT NULL,
	"login_email" text NOT NULL,
	"external_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"profile" jsonb NOT NULL,
	"user_id" uuid,
	"revision" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "auth_directory_user_org_identity_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "auth_directory_user_binding_identity_unique" UNIQUE("organization_id","id","user_id"),
	CONSTRAINT "auth_directory_user_name_valid" CHECK (length(user_name) between 1 and 320 and length(normalized_user_name) between 1 and 320),
	CONSTRAINT "auth_directory_user_email_valid" CHECK (length(login_email) between 3 and 320),
	CONSTRAINT "auth_directory_user_external_valid" CHECK (external_id is null or length(external_id) between 1 and 512),
	CONSTRAINT "auth_directory_user_revision_positive" CHECK (revision>0),
	CONSTRAINT "auth_directory_user_profile_bounded" CHECK (jsonb_typeof(profile)='object' and octet_length(profile::text)<=16384),
	CONSTRAINT "auth_directory_user_deleted_inactive" CHECK (deleted_at is null or not active)
);
--> statement-breakpoint
ALTER TABLE "app"."auth_organization_workspaces" ADD CONSTRAINT "auth_organization_workspace_identity_unique" UNIQUE("organization_id","workspace_id");
--> statement-breakpoint
ALTER TABLE "app"."auth_provisioning_credentials" ADD CONSTRAINT "auth_provisioning_credential_org_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."auth_organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."auth_provisioning_credentials" ADD CONSTRAINT "auth_provisioning_credential_creator_fk" FOREIGN KEY ("created_by") REFERENCES "app"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."auth_directory_groups" ADD CONSTRAINT "auth_directory_group_org_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."auth_organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."auth_directory_group_mappings" ADD CONSTRAINT "auth_directory_group_mapping_group_fk" FOREIGN KEY ("organization_id","group_id") REFERENCES "app"."auth_directory_groups"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."auth_directory_group_mappings" ADD CONSTRAINT "auth_directory_group_mapping_workspace_fk" FOREIGN KEY ("organization_id","workspace_id") REFERENCES "app"."auth_organization_workspaces"("organization_id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."auth_directory_group_members" ADD CONSTRAINT "auth_directory_group_member_group_fk" FOREIGN KEY ("organization_id","group_id") REFERENCES "app"."auth_directory_groups"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."auth_directory_group_members" ADD CONSTRAINT "auth_directory_group_member_user_fk" FOREIGN KEY ("organization_id","directory_user_id") REFERENCES "app"."auth_directory_users"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."auth_directory_memberships" ADD CONSTRAINT "auth_directory_membership_member_fk" FOREIGN KEY ("workspace_id","user_id") REFERENCES "app"."workspace_memberships"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."auth_directory_memberships" ADD CONSTRAINT "auth_directory_membership_identity_fk" FOREIGN KEY ("organization_id","directory_user_id","user_id") REFERENCES "app"."auth_directory_users"("organization_id","id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."auth_directory_memberships" ADD CONSTRAINT "auth_directory_membership_workspace_fk" FOREIGN KEY ("organization_id","workspace_id") REFERENCES "app"."auth_organization_workspaces"("organization_id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."auth_directory_users" ADD CONSTRAINT "auth_directory_user_org_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."auth_organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."auth_directory_users" ADD CONSTRAINT "auth_directory_user_account_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_provisioning_credential_org_idx" ON "app"."auth_provisioning_credentials" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_directory_group_external_unique" ON "app"."auth_directory_groups" USING btree ("organization_id","external_id") WHERE external_id is not null;--> statement-breakpoint
CREATE INDEX "auth_directory_group_member_user_idx" ON "app"."auth_directory_group_members" USING btree ("organization_id","directory_user_id","group_id");--> statement-breakpoint
CREATE INDEX "auth_directory_membership_user_idx" ON "app"."auth_directory_memberships" USING btree ("organization_id","directory_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_directory_user_live_name_unique" ON "app"."auth_directory_users" USING btree ("organization_id","normalized_user_name") WHERE deleted_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_directory_user_live_email_unique" ON "app"."auth_directory_users" USING btree ("organization_id","login_email") WHERE deleted_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_directory_user_live_external_unique" ON "app"."auth_directory_users" USING btree ("organization_id","external_id") WHERE deleted_at is null and external_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_directory_user_live_binding_unique" ON "app"."auth_directory_users" USING btree ("organization_id","user_id") WHERE deleted_at is null and user_id is not null;--> statement-breakpoint
CREATE INDEX "auth_directory_user_bound_idx" ON "app"."auth_directory_users" USING btree ("user_id","organization_id");--> statement-breakpoint
CREATE INDEX "auth_directory_user_email_idx" ON "app"."auth_directory_users" USING btree ("organization_id","login_email");--> statement-breakpoint

--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE,DELETE ON app.auth_directory_users,app.auth_directory_groups,app.auth_directory_group_members,app.auth_directory_group_mappings,app.auth_directory_memberships,app.auth_provisioning_credentials TO {{app_role}};
GRANT SELECT,DELETE ON app.auth_directory_users,app.auth_directory_groups,app.auth_directory_group_members,app.auth_directory_group_mappings,app.auth_directory_memberships,app.auth_provisioning_credentials TO {{maintenance_role}};
ALTER TABLE app.auth_directory_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.auth_directory_memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY directory_memberships_workspace_scope ON app.auth_directory_memberships TO {{app_role}}
 USING (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),'')) WITH CHECK (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''));
CREATE POLICY directory_memberships_owner ON app.auth_directory_memberships TO {{owner_role}} USING (true) WITH CHECK (true);
CREATE POLICY directory_memberships_maintenance ON app.auth_directory_memberships TO {{maintenance_role}} USING (true) WITH CHECK (true);

GRANT UPDATE(role,status,role_revision,updated_at) ON app.workspace_memberships TO {{maintenance_role}};
GRANT EXECUTE ON FUNCTION app.clear_removed_member_notices(uuid,uuid) TO {{maintenance_role}};
