CREATE TABLE "app"."api_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"name" varchar(128) NOT NULL,
	"secret_digest" char(64) NOT NULL,
	"scopes" jsonb NOT NULL,
	"membership_revision" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "api_tokens_name_bounded" CHECK (length(btrim(name)) between 1 and 128),
	CONSTRAINT "api_tokens_digest_valid" CHECK (secret_digest ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "api_tokens_revision_positive" CHECK (membership_revision > 0),
	CONSTRAINT "api_tokens_expiry_valid" CHECK (expires_at > created_at and expires_at <= created_at + interval '31536000 seconds'),
	CONSTRAINT "api_tokens_scopes_valid" CHECK (jsonb_typeof(scopes) = 'array' and jsonb_array_length(scopes) between 1 and 7 and scopes <@ '["workflow:read","workflow:create","workflow:publish","run:read","run:start","run:cancel","connection:read"]'::jsonb)
);
--> statement-breakpoint
ALTER TABLE "app"."workflow_manual_start_rejections" DROP CONSTRAINT "workflow_manual_start_rejections_check";--> statement-breakpoint
ALTER TABLE "app"."api_tokens" ADD CONSTRAINT "api_tokens_membership_fk" FOREIGN KEY ("workspace_id","owner_user_id") REFERENCES "app"."workspace_memberships"("workspace_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_tokens_owner_page_idx" ON "app"."api_tokens" USING btree ("workspace_id","owner_user_id","id");--> statement-breakpoint
CREATE INDEX "api_tokens_expiry_idx" ON "app"."api_tokens" USING btree ("expires_at","id");--> statement-breakpoint
CREATE INDEX "api_tokens_revoked_idx" ON "app"."api_tokens" USING btree ("revoked_at","id") WHERE revoked_at is not null;--> statement-breakpoint
ALTER TABLE "app"."workflow_manual_start_rejections" ADD CONSTRAINT "workflow_manual_start_rejections_check" CHECK (((scope)::text = (('workflow:'::text || (workflow_id)::text) || ':manual'::text) OR (scope)::text ~ '^api_token:[0-9a-f]{64}$'::text));
--> statement-breakpoint
ALTER TABLE app.api_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.api_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY api_tokens_workspace_scope ON app.api_tokens TO {{app_role}}
  USING (workspace_id::text = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK (workspace_id::text = NULLIF(current_setting('app.workspace_id', true), ''));
CREATE POLICY api_tokens_owner ON app.api_tokens TO {{owner_role}} USING (true) WITH CHECK (true);
CREATE POLICY api_tokens_maintenance ON app.api_tokens TO {{maintenance_role}} USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON app.api_tokens TO {{app_role}};
GRANT UPDATE (revoked_at, last_used_at) ON app.api_tokens TO {{app_role}};
GRANT SELECT, DELETE ON app.api_tokens TO {{maintenance_role}};
