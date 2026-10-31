CREATE TABLE "app"."connection_oauth2_authorizations" (
	"workspace_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"state_digest" "bytea" NOT NULL,
	"binding_digest" "bytea" NOT NULL,
	"started_by" uuid NOT NULL,
	"secret_version_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "connection_oauth2_authorizations_pkey" PRIMARY KEY("workspace_id","connection_id"),
	CONSTRAINT "connection_oauth2_authorizations_state_unique" UNIQUE("workspace_id","state_digest"),
	CONSTRAINT "connection_oauth2_authorizations_state_digest_size" CHECK (octet_length(state_digest) = 32),
	CONSTRAINT "connection_oauth2_authorizations_binding_digest_size" CHECK (octet_length(binding_digest) = 32)
);
--> statement-breakpoint
CREATE TABLE "app"."connection_oauth2_clients" (
	"workspace_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"secret_version_id" uuid NOT NULL,
	"settings" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "connection_oauth2_clients_pkey" PRIMARY KEY("workspace_id","connection_id","secret_version_id"),
	CONSTRAINT "connection_oauth2_clients_settings_bounded" CHECK (octet_length(settings::text) <= 16384)
);
--> statement-breakpoint
CREATE TABLE "app"."connection_oauth2_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"secret_version_id" uuid NOT NULL,
	"kms_key_reference" varchar(2048) NOT NULL,
	"encrypted_data_key" text NOT NULL,
	"ciphertext" text NOT NULL,
	"nonce" varchar(64) NOT NULL,
	"auth_tag" varchar(64) NOT NULL,
	"authorized_at" timestamp with time zone NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"access_token_expires_at" timestamp with time zone,
	"renewable" boolean NOT NULL,
	"refresh_blocked_until" timestamp with time zone,
	CONSTRAINT "connection_oauth2_tokens_one_per_connection" UNIQUE("workspace_id","connection_id"),
	CONSTRAINT "connection_oauth2_tokens_ciphertext_bounded" CHECK (((length(ciphertext) >= 1) AND (length(ciphertext) <= 87382) AND (ciphertext ~ '^[A-Za-z0-9_-]+$'::text))),
	CONSTRAINT "connection_oauth2_tokens_encrypted_key_bounded" CHECK (((length(encrypted_data_key) >= 1) AND (length(encrypted_data_key) <= 10923) AND (encrypted_data_key ~ '^[A-Za-z0-9_-]+$'::text))),
	CONSTRAINT "connection_oauth2_tokens_kms_reference_bounded" CHECK (((length((kms_key_reference)::text) >= 1) AND (length((kms_key_reference)::text) <= 2048))),
	CONSTRAINT "connection_oauth2_tokens_nonce_valid" CHECK (((length((nonce)::text) = 16) AND ((nonce)::text ~ '^[A-Za-z0-9_-]+$'::text))),
	CONSTRAINT "connection_oauth2_tokens_tag_valid" CHECK (((length((auth_tag)::text) = 22) AND ((auth_tag)::text ~ '^[A-Za-z0-9_-]+$'::text)))
);
--> statement-breakpoint
ALTER TABLE "app"."connection_events" DROP CONSTRAINT "connection_events_type_valid";--> statement-breakpoint
ALTER TABLE "app"."connections" DROP CONSTRAINT "connections_auth_type_valid";--> statement-breakpoint
ALTER TABLE "app"."connection_oauth2_authorizations" ADD CONSTRAINT "connection_oauth2_authorizations_client_fk" FOREIGN KEY ("workspace_id","connection_id","secret_version_id") REFERENCES "app"."connection_oauth2_clients"("workspace_id","connection_id","secret_version_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."connection_oauth2_authorizations" ADD CONSTRAINT "connection_oauth2_authorizations_member_fk" FOREIGN KEY ("workspace_id","started_by") REFERENCES "app"."workspace_memberships"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."connection_oauth2_clients" ADD CONSTRAINT "connection_oauth2_clients_secret_version_fk" FOREIGN KEY ("workspace_id","connection_id","secret_version_id") REFERENCES "app"."connection_secret_versions"("workspace_id","connection_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."connection_oauth2_tokens" ADD CONSTRAINT "connection_oauth2_tokens_client_fk" FOREIGN KEY ("workspace_id","connection_id","secret_version_id") REFERENCES "app"."connection_oauth2_clients"("workspace_id","connection_id","secret_version_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."connection_events" ADD CONSTRAINT "connection_events_type_valid" CHECK (((event_type)::text = ANY (ARRAY[('connection.created'::character varying)::text, ('connection.secret_rotated'::character varying)::text, ('connection.test_succeeded'::character varying)::text, ('connection.test_failed'::character varying)::text, ('connection.reauthorization_required'::character varying)::text, ('connection.revoked'::character varying)::text, ('connection.credential_accessed'::character varying)::text, ('connection.health_changed'::character varying)::text, ('connection.oauth2_authorized'::character varying)::text])));--> statement-breakpoint
ALTER TABLE "app"."connections" ADD CONSTRAINT "connections_auth_type_valid" CHECK (((auth_type)::text = ANY (ARRAY[('hmac_key'::character varying)::text, ('http_headers'::character varying)::text, ('slack_bot_token'::character varying)::text, ('resend_api_key'::character varying)::text, ('oauth2'::character varying)::text])));--> statement-breakpoint
ALTER TABLE app.connection_oauth2_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.connection_oauth2_clients FORCE ROW LEVEL SECURITY;
CREATE POLICY connection_oauth2_clients_workspace_scope ON app.connection_oauth2_clients TO {{app_role}}
 USING (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''))
 WITH CHECK (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''));
CREATE POLICY connection_oauth2_clients_owner ON app.connection_oauth2_clients TO {{owner_role}} USING (true) WITH CHECK (true);
CREATE POLICY connection_oauth2_clients_maintenance ON app.connection_oauth2_clients TO {{maintenance_role}} USING (true) WITH CHECK (true);
GRANT SELECT,INSERT,UPDATE,DELETE ON app.connection_oauth2_clients TO {{app_role}};
GRANT SELECT,DELETE ON app.connection_oauth2_clients TO {{maintenance_role}};
--> statement-breakpoint
ALTER TABLE app.connection_oauth2_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.connection_oauth2_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY connection_oauth2_tokens_workspace_scope ON app.connection_oauth2_tokens TO {{app_role}}
 USING (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''))
 WITH CHECK (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''));
CREATE POLICY connection_oauth2_tokens_owner ON app.connection_oauth2_tokens TO {{owner_role}} USING (true) WITH CHECK (true);
CREATE POLICY connection_oauth2_tokens_maintenance ON app.connection_oauth2_tokens TO {{maintenance_role}} USING (true) WITH CHECK (true);
GRANT SELECT,INSERT,UPDATE,DELETE ON app.connection_oauth2_tokens TO {{app_role}};
GRANT SELECT,DELETE ON app.connection_oauth2_tokens TO {{maintenance_role}};
--> statement-breakpoint
ALTER TABLE app.connection_oauth2_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.connection_oauth2_authorizations FORCE ROW LEVEL SECURITY;
CREATE POLICY connection_oauth2_authorizations_workspace_scope ON app.connection_oauth2_authorizations TO {{app_role}}
 USING (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''))
 WITH CHECK (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''));
CREATE POLICY connection_oauth2_authorizations_owner ON app.connection_oauth2_authorizations TO {{owner_role}} USING (true) WITH CHECK (true);
CREATE POLICY connection_oauth2_authorizations_maintenance ON app.connection_oauth2_authorizations TO {{maintenance_role}} USING (true) WITH CHECK (true);
GRANT SELECT,INSERT,UPDATE,DELETE ON app.connection_oauth2_authorizations TO {{app_role}};
GRANT SELECT,DELETE ON app.connection_oauth2_authorizations TO {{maintenance_role}};
