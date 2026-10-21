CREATE TABLE "app"."connection_shares" (
	"workspace_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "connection_shares_workspace_id_connection_id_user_id_pk" PRIMARY KEY("workspace_id","connection_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "app"."connections" ADD COLUMN "access_mode" varchar(16) DEFAULT 'workspace' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."connections" ADD COLUMN "sharing_revision" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."connection_shares" ADD CONSTRAINT "connection_shares_connection_fk" FOREIGN KEY ("workspace_id","connection_id") REFERENCES "app"."connections"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."connection_shares" ADD CONSTRAINT "connection_shares_member_fk" FOREIGN KEY ("workspace_id","user_id") REFERENCES "app"."workspace_memberships"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connection_shares_member_idx" ON "app"."connection_shares" USING btree ("workspace_id","user_id","connection_id");--> statement-breakpoint
ALTER TABLE "app"."connections" ADD CONSTRAINT "connections_access_mode_valid" CHECK (access_mode in ('workspace','restricted'));--> statement-breakpoint
ALTER TABLE "app"."connections" ADD CONSTRAINT "connections_sharing_revision_positive" CHECK (sharing_revision > 0);
--> statement-breakpoint
ALTER TABLE app.connection_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.connection_shares FORCE ROW LEVEL SECURITY;
CREATE POLICY connection_shares_workspace_scope ON app.connection_shares TO {{app_role}}
 USING (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''))
 WITH CHECK (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''));
CREATE POLICY connection_shares_owner ON app.connection_shares TO {{owner_role}} USING (true) WITH CHECK (true);
CREATE POLICY connection_shares_maintenance ON app.connection_shares TO {{maintenance_role}} USING (true) WITH CHECK (true);
GRANT SELECT,INSERT,UPDATE,DELETE ON app.connection_shares TO {{app_role}};
GRANT SELECT,DELETE ON app.connection_shares TO {{maintenance_role}};
GRANT UPDATE(access_mode,sharing_revision) ON app.connections TO {{app_role}};
GRANT UPDATE(sharing_revision) ON app.connections TO {{maintenance_role}};
