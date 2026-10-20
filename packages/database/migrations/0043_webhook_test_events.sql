CREATE TABLE "app"."webhook_test_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"node_id" varchar(64) NOT NULL,
	"created_by" uuid NOT NULL,
	"endpoint_key_hash" char(64) NOT NULL,
	"binding" text NOT NULL,
	"authentication" jsonb NOT NULL,
	"kms_key_reference" varchar(2048) NOT NULL,
	"encrypted_data_key" text NOT NULL,
	"ciphertext" text NOT NULL,
	"nonce" varchar(64) NOT NULL,
	"auth_tag" varchar(64) NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"output_ref" text,
	"received_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "webhook_test_events_key" UNIQUE("endpoint_key_hash"),
	CONSTRAINT "webhook_test_events_workflow" UNIQUE("workspace_id","workflow_id"),
	CONSTRAINT "webhook_test_events_hash_valid" CHECK (endpoint_key_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "webhook_test_events_attempts_valid" CHECK (attempts between 0 and 60),
	CONSTRAINT "webhook_test_events_output_valid" CHECK ((output_ref IS NULL AND received_at IS NULL) OR (output_ref IS NOT NULL AND received_at IS NOT NULL AND octet_length(output_ref)<=262200 AND output_ref::jsonb->>'kind'='inline')),
	CONSTRAINT "webhook_test_events_expiry_valid" CHECK (expires_at > created_at)
);
--> statement-breakpoint
ALTER TABLE "app"."webhook_test_events" ADD CONSTRAINT "webhook_test_events_workflow_fk" FOREIGN KEY ("workspace_id","workflow_id") REFERENCES "app"."workflows"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_test_events_expiry_idx" ON "app"."webhook_test_events" USING btree ("expires_at","id");
--> statement-breakpoint
ALTER TABLE app.webhook_test_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.webhook_test_events FORCE ROW LEVEL SECURITY;
CREATE POLICY webhook_test_events_workspace_scope ON app.webhook_test_events TO {{app_role}}
 USING (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''))
 WITH CHECK (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''));
CREATE POLICY webhook_test_events_owner ON app.webhook_test_events TO {{owner_role}} USING (true) WITH CHECK (true);
CREATE POLICY webhook_test_events_maintenance ON app.webhook_test_events TO {{maintenance_role}} USING (true) WITH CHECK (true);
GRANT SELECT,INSERT,UPDATE,DELETE ON app.webhook_test_events TO {{app_role}};
GRANT SELECT,DELETE,UPDATE(expires_at) ON app.webhook_test_events TO {{maintenance_role}};

-- Resolve only the opaque address's workspace; TypeScript owns authoring policy.
CREATE FUNCTION app.resolve_webhook_test_event(p_key_hash character)
 RETURNS TABLE(workspace_id uuid,id uuid)
 LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog','app'
 SET row_security TO 'on'
 AS $$ SELECT event.workspace_id,event.id FROM app.webhook_test_events event
 WHERE event.endpoint_key_hash=p_key_hash AND event.output_ref IS NULL
 AND event.expires_at>clock_timestamp() $$;
REVOKE ALL ON FUNCTION app.resolve_webhook_test_event(character) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_webhook_test_event(character) TO {{app_role}};
