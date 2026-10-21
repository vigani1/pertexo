ALTER TABLE "app"."pending_run_tasks" DROP CONSTRAINT "pending_run_tasks_kind_valid";--> statement-breakpoint
ALTER TABLE "app"."pending_run_tasks" DROP CONSTRAINT "pending_run_tasks_result_kind_valid";--> statement-breakpoint
ALTER TABLE "app"."pending_run_tasks" DROP CONSTRAINT "pending_run_tasks_expiry_valid";--> statement-breakpoint
ALTER TABLE "app"."pending_run_tasks" DROP CONSTRAINT "pending_run_tasks_state_valid";--> statement-breakpoint
ALTER TABLE "app"."pending_run_tasks" ALTER COLUMN "node_run_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."pending_run_tasks" ALTER COLUMN "expires_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."pending_run_tasks" ADD COLUMN "callback_node_id" varchar(64);--> statement-breakpoint
ALTER TABLE "app"."pending_run_tasks" ADD COLUMN "callback_scope" jsonb;--> statement-breakpoint
ALTER TABLE "app"."pending_run_tasks" ADD COLUMN "callback_scope_hash" char(64);--> statement-breakpoint
ALTER TABLE "app"."pending_run_tasks" ADD COLUMN "callback_token_hash" char(64);--> statement-breakpoint
ALTER TABLE "app"."pending_run_tasks" ADD COLUMN "callback_key_version" varchar(64);--> statement-breakpoint
ALTER TABLE "app"."pending_run_tasks" ADD COLUMN "opened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."pending_run_tasks" ADD CONSTRAINT "pending_run_tasks_callback_token_unique" UNIQUE("callback_token_hash");--> statement-breakpoint
ALTER TABLE "app"."pending_run_tasks" ADD CONSTRAINT "pending_run_tasks_callback_scope_unique" UNIQUE("workspace_id","run_id","callback_node_id","callback_scope_hash");--> statement-breakpoint
ALTER TABLE "app"."pending_run_tasks" ADD CONSTRAINT "pending_run_tasks_binding_valid" CHECK (((kind<>'callback' AND node_run_id IS NOT NULL AND callback_node_id IS NULL AND callback_scope IS NULL AND callback_scope_hash IS NULL AND callback_token_hash IS NULL AND callback_key_version IS NULL AND opened_at IS NULL) OR (kind='callback' AND (status<>'pending' OR node_run_id IS NOT NULL) AND callback_node_id IS NOT NULL AND jsonb_typeof(callback_scope)='array' AND octet_length(callback_scope::text)<=8192 AND callback_scope_hash ~ '^[0-9a-f]{64}$' AND callback_token_hash ~ '^[0-9a-f]{64}$' AND callback_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$' AND ((node_run_id IS NULL AND opened_at IS NULL) OR (node_run_id IS NOT NULL AND opened_at IS NOT NULL)))) IS TRUE);--> statement-breakpoint
ALTER TABLE "app"."pending_run_tasks" ADD CONSTRAINT "pending_run_tasks_kind_valid" CHECK (kind IN ('approval', 'input_request','callback'));--> statement-breakpoint
ALTER TABLE "app"."pending_run_tasks" ADD CONSTRAINT "pending_run_tasks_result_kind_valid" CHECK ((status NOT IN ('approved','rejected','submitted') OR (kind='approval' AND status IN ('approved','rejected')) OR (kind IN ('input_request','callback') AND status='submitted')) IS TRUE);--> statement-breakpoint
ALTER TABLE "app"."pending_run_tasks" ADD CONSTRAINT "pending_run_tasks_expiry_valid" CHECK (((kind<>'callback' AND expires_at > created_at AND expires_at <= created_at + interval '30 days') OR (kind='callback' AND ((opened_at IS NULL AND expires_at IS NULL) OR (opened_at IS NOT NULL AND expires_at>opened_at AND expires_at<=opened_at+interval '30 days')))) IS TRUE);--> statement-breakpoint
ALTER TABLE "app"."pending_run_tasks" ADD CONSTRAINT "pending_run_tasks_state_valid" CHECK (((kind='callback' AND status='prepared' AND node_run_id IS NULL AND opened_at IS NULL AND output_ref IS NULL AND decided_by IS NULL AND completed_at IS NULL AND consumed_at IS NULL)
    OR (status = 'pending' AND output_ref IS NULL AND decided_by IS NULL AND completed_at IS NULL AND consumed_at IS NULL)
    OR (status IN ('approved','rejected','submitted') AND output_ref IS NOT NULL AND ((kind='callback' AND decided_by IS NULL) OR (kind<>'callback' AND decided_by IS NOT NULL)) AND completed_at IS NOT NULL)
    OR (status IN ('expired','refused','canceled') AND output_ref IS NULL AND decided_by IS NULL AND completed_at IS NOT NULL)) IS TRUE);
--> statement-breakpoint
CREATE FUNCTION app.resolve_public_pending_callback(p_hash char(64))
RETURNS TABLE(id uuid,workspace_id uuid,run_id uuid,callback_node_id varchar,callback_scope_hash char(64),callback_token_hash char(64),callback_key_version varchar,config jsonb,database_time timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO pg_catalog,app SET row_security TO on AS $$
 SELECT task.id,task.workspace_id,task.run_id,task.callback_node_id,task.callback_scope_hash,task.callback_token_hash,task.callback_key_version,task.config,clock_timestamp()
 FROM app.pending_run_tasks task WHERE task.kind='callback' AND task.callback_token_hash=p_hash
$$;
REVOKE ALL ON FUNCTION app.resolve_public_pending_callback(char(64)) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_public_pending_callback(char(64)) TO {{app_role}};
--> statement-breakpoint
CREATE FUNCTION app.pending_callback_key_inventory(p_after uuid)
RETURNS TABLE(id uuid,callback_token_hash char(64),callback_key_version varchar)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO pg_catalog,app SET row_security TO on AS $$
 SELECT task.id,task.callback_token_hash,task.callback_key_version
 FROM app.pending_run_tasks task WHERE task.kind='callback' AND (p_after IS NULL OR task.id>p_after) ORDER BY task.id LIMIT 250
$$;
REVOKE ALL ON FUNCTION app.pending_callback_key_inventory(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.pending_callback_key_inventory(uuid) TO {{app_role}};

--> statement-breakpoint
CREATE INDEX "pending_run_tasks_callback_inventory_idx" ON "app"."pending_run_tasks" USING btree ("id") WHERE kind='callback';
--> statement-breakpoint
GRANT UPDATE(node_run_id,invocation_key,opened_at,expires_at) ON app.pending_run_tasks TO {{app_role}};

--> statement-breakpoint
-- Retention locks each bounded page before deleting prepared callback rows.
GRANT UPDATE(consumed_at) ON app.pending_run_tasks TO {{maintenance_role}};
