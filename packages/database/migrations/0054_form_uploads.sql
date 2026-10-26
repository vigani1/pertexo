CREATE TABLE "app"."form_uploads" (
	"workspace_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"workflow_version_id" uuid,
	"task_id" uuid,
	"field_id" varchar(64) NOT NULL,
	"filename" varchar(255) NOT NULL,
	"session_hash" char(64) NOT NULL,
	"capability_hash" char(64),
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "form_uploads_workspace_id_artifact_id_pk" PRIMARY KEY("workspace_id","artifact_id"),
	CONSTRAINT "form_uploads_target_valid" CHECK ((workflow_version_id IS NULL) <> (task_id IS NULL)),
	CONSTRAINT "form_uploads_responder_valid" CHECK ((capability_hash IS NULL) <> (uploaded_by IS NULL) AND (capability_hash IS NULL OR task_id IS NULL)),
	CONSTRAINT "form_uploads_hashes_valid" CHECK (session_hash ~ '^[0-9a-f]{64}$' AND (capability_hash IS NULL OR capability_hash ~ '^[0-9a-f]{64}$'))
);
--> statement-breakpoint
ALTER TABLE "app"."form_uploads" ADD CONSTRAINT "form_uploads_artifact_fk" FOREIGN KEY ("workspace_id","artifact_id") REFERENCES "app"."artifacts"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "form_uploads_session_idx" ON "app"."form_uploads" USING btree ("workspace_id","session_hash");
--> statement-breakpoint
ALTER TABLE app.form_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.form_uploads FORCE ROW LEVEL SECURITY;
CREATE POLICY form_uploads_workspace_scope ON app.form_uploads TO {{app_role}}
 USING (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''))
 WITH CHECK (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''));
CREATE POLICY form_uploads_owner ON app.form_uploads TO {{owner_role}} USING (true) WITH CHECK (true);
CREATE POLICY form_uploads_maintenance ON app.form_uploads TO {{maintenance_role}} USING (true) WITH CHECK (true);
GRANT SELECT,INSERT ON app.form_uploads TO {{app_role}};
GRANT SELECT,DELETE ON app.form_uploads TO {{maintenance_role}};
