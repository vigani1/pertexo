CREATE TABLE "app"."workflow_forms" (
	"workspace_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"public_id" uuid NOT NULL,
	"node_id" varchar(128) NOT NULL,
	"access" varchar(16) DEFAULT 'members' NOT NULL,
	"capability_hash" char(64),
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_forms_workspace_id_workflow_id_pk" PRIMARY KEY("workspace_id","workflow_id"),
	CONSTRAINT "workflow_forms_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "workflow_forms_revision_positive" CHECK (revision>0),
	CONSTRAINT "workflow_forms_access_valid" CHECK (((access='members' AND capability_hash IS NULL) OR (access='public' AND capability_hash ~ '^[0-9a-f]{64}$')) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "app"."workflow_runs" DROP CONSTRAINT "workflow_runs_trigger_type_valid";--> statement-breakpoint
ALTER TABLE "app"."pending_run_tasks" DROP CONSTRAINT "pending_run_tasks_kind_valid";--> statement-breakpoint
ALTER TABLE "app"."pending_run_tasks" DROP CONSTRAINT "pending_run_tasks_state_valid";--> statement-breakpoint
ALTER TABLE "app"."workflow_forms" ADD CONSTRAINT "workflow_forms_workspace_id_workflow_id_workflows_workspace_id_id_fk" FOREIGN KEY ("workspace_id","workflow_id") REFERENCES "app"."workflows"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workflow_runs" ADD CONSTRAINT "workflow_runs_trigger_type_valid" CHECK (((trigger_type)::text = ANY (ARRAY[('form'::character varying)::text, ('workflow_error'::character varying)::text, ('api'::character varying)::text, ('manual'::character varying)::text, ('replay'::character varying)::text, ('schedule'::character varying)::text, ('webhook'::character varying)::text, ('workflow_call'::character varying)::text])));--> statement-breakpoint
ALTER TABLE "app"."pending_run_tasks" ADD CONSTRAINT "pending_run_tasks_result_kind_valid" CHECK ((status NOT IN ('approved','rejected','submitted') OR (kind='approval' AND status IN ('approved','rejected')) OR (kind='input_request' AND status='submitted')) IS TRUE);--> statement-breakpoint
ALTER TABLE "app"."pending_run_tasks" ADD CONSTRAINT "pending_run_tasks_kind_valid" CHECK (kind IN ('approval', 'input_request'));--> statement-breakpoint
ALTER TABLE "app"."pending_run_tasks" ADD CONSTRAINT "pending_run_tasks_state_valid" CHECK (((status = 'pending' AND output_ref IS NULL AND decided_by IS NULL AND completed_at IS NULL AND consumed_at IS NULL)
    OR (status IN ('approved','rejected','submitted') AND output_ref IS NOT NULL AND decided_by IS NOT NULL AND completed_at IS NOT NULL)
    OR (status IN ('expired','refused','canceled') AND output_ref IS NULL AND decided_by IS NULL AND completed_at IS NOT NULL)) IS TRUE);
--> statement-breakpoint
ALTER TABLE app.workflow_forms ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_forms FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_forms_workspace_scope ON app.workflow_forms TO {{app_role}}
  USING (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''))
  WITH CHECK (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''));
CREATE POLICY workflow_forms_owner ON app.workflow_forms TO {{owner_role}} USING (true) WITH CHECK (true);
CREATE POLICY workflow_forms_maintenance ON app.workflow_forms TO {{maintenance_role}} USING (true) WITH CHECK (true);
GRANT SELECT,INSERT ON app.workflow_forms TO {{app_role}};
GRANT UPDATE(node_id,access,capability_hash,revision,updated_at) ON app.workflow_forms TO {{app_role}};
GRANT SELECT,DELETE ON app.workflow_forms TO {{maintenance_role}};

-- Only a matching public capability can discover the tenant boundary.
CREATE FUNCTION app.lookup_public_form(p_public_id uuid,p_digest char(64))
RETURNS TABLE(workspace_id uuid,workflow_id uuid,node_id varchar)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog','app','pg_temp' SET row_security TO 'on'
AS $$ SELECT form.workspace_id,form.workflow_id,form.node_id FROM app.workflow_forms form
  JOIN app.workspaces workspace ON workspace.id=form.workspace_id AND workspace.status='active'
  WHERE form.public_id=p_public_id AND form.access='public' AND form.capability_hash=p_digest $$;
REVOKE ALL ON FUNCTION app.lookup_public_form(uuid,char) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lookup_public_form(uuid,char) TO {{app_role}};
