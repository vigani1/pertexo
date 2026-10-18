CREATE TABLE "app"."auth_domains" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"challenge" text,
	"challenge_expires_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"require_sso" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "auth_domain_organization_identity_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "auth_domain_organization_name_unique" UNIQUE("organization_id","domain"),
	CONSTRAINT "auth_domain_name_valid" CHECK (length(domain) between 3 and 253 AND domain=lower(domain)),
	CONSTRAINT "auth_domain_revision_positive" CHECK (revision>0),
	CONSTRAINT "auth_domain_challenge_valid" CHECK ((challenge is null AND challenge_expires_at is null) OR (challenge is not null AND challenge ~ '^[A-Za-z0-9_-]{43}$' AND challenge_expires_at is not null))
);
--> statement-breakpoint
CREATE TABLE "app"."auth_federation_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"provider_revision" integer NOT NULL,
	"domain_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"owner_user_id" uuid,
	"owner_session_id" uuid,
	"state_digest" "bytea" NOT NULL,
	"browser_digest" "bytea" NOT NULL,
	"return_path" text NOT NULL,
	"request_id" text,
	"request_created_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "auth_federation_attempt_state_unique" UNIQUE("state_digest"),
	CONSTRAINT "auth_federation_attempt_digest_valid" CHECK (octet_length(state_digest)=32 AND octet_length(browser_digest)=32),
	CONSTRAINT "auth_federation_attempt_revision_positive" CHECK (provider_revision>0),
	CONSTRAINT "auth_federation_attempt_purpose_valid" CHECK ((purpose='sign_in' AND owner_user_id is null AND owner_session_id is null) OR (purpose='test' AND owner_user_id is not null AND owner_session_id is not null)),
	CONSTRAINT "auth_federation_attempt_path_valid" CHECK (length(return_path) between 1 and 256 AND left(return_path,1)='/'),
	CONSTRAINT "auth_federation_attempt_expiry_valid" CHECK (expires_at>created_at)
);
--> statement-breakpoint
CREATE TABLE "app"."auth_organization_workspaces" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"default_role" text DEFAULT 'viewer' NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "auth_organization_workspace_role_valid" CHECK (default_role in ('viewer','builder','operator','admin'))
);
--> statement-breakpoint
CREATE TABLE "app"."auth_organizations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"control_workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "auth_organization_control_unique" UNIQUE("control_workspace_id"),
	CONSTRAINT "auth_organization_name_valid" CHECK (length(btrim(name)) between 1 and 128),
	CONSTRAINT "auth_organization_revision_positive" CHECK (revision>0)
);
--> statement-breakpoint
CREATE TABLE "app"."auth_provider_checks" (
	"organization_id" uuid NOT NULL,
	"domain_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"provider_revision" integer NOT NULL,
	"tested_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "auth_provider_checks_pkey" PRIMARY KEY("organization_id","domain_id","provider_id"),
	CONSTRAINT "auth_provider_check_revision_positive" CHECK (provider_revision>0)
);
--> statement-breakpoint
CREATE TABLE "app"."auth_providers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"issuer" text NOT NULL,
	"configuration" jsonb NOT NULL,
	"sealed_secret" jsonb,
	"enabled" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "auth_provider_organization_identity_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "auth_provider_secret_presence_valid" CHECK (kind <> 'oidc' OR sealed_secret is not null),
	CONSTRAINT "auth_provider_kind_valid" CHECK (kind in ('oidc','saml')),
	CONSTRAINT "auth_provider_name_valid" CHECK (length(btrim(name)) between 1 and 128),
	CONSTRAINT "auth_provider_issuer_valid" CHECK (length(issuer) between 1 and 2048),
	CONSTRAINT "auth_provider_revision_positive" CHECK (revision>0),
	CONSTRAINT "auth_provider_configuration_bounded" CHECK (jsonb_typeof(configuration)='object' AND octet_length(configuration::text)<=131072),
	CONSTRAINT "auth_provider_secret_bounded" CHECK (sealed_secret is null OR (jsonb_typeof(sealed_secret)='object' AND octet_length(sealed_secret::text)<=32768))
);
--> statement-breakpoint
ALTER TABLE "app"."auth_sessions" ADD COLUMN "authentication_method" text DEFAULT 'credential' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."auth_sessions" ADD COLUMN "federation_provider_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."auth_sessions" ADD COLUMN "federation_provider_revision" integer;--> statement-breakpoint
ALTER TABLE "app"."workspace_invitation_acceptance_intents" ADD COLUMN "verified_session_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."auth_domains" ADD CONSTRAINT "auth_domain_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."auth_organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."auth_federation_attempts" ADD CONSTRAINT "auth_federation_attempt_provider_fk" FOREIGN KEY ("organization_id","provider_id") REFERENCES "app"."auth_providers"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."auth_federation_attempts" ADD CONSTRAINT "auth_federation_attempt_domain_fk" FOREIGN KEY ("organization_id","domain_id") REFERENCES "app"."auth_domains"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."auth_organization_workspaces" ADD CONSTRAINT "auth_organization_workspace_org_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."auth_organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."auth_organization_workspaces" ADD CONSTRAINT "auth_organization_workspace_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."auth_organizations" ADD CONSTRAINT "auth_organization_control_fk" FOREIGN KEY ("control_workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."auth_provider_checks" ADD CONSTRAINT "auth_provider_check_domain_fk" FOREIGN KEY ("organization_id","domain_id") REFERENCES "app"."auth_domains"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."auth_provider_checks" ADD CONSTRAINT "auth_provider_check_provider_fk" FOREIGN KEY ("organization_id","provider_id") REFERENCES "app"."auth_providers"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."auth_providers" ADD CONSTRAINT "auth_provider_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."auth_organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_domain_claim_unique" ON "app"."auth_domains" USING btree ("domain") WHERE verified_at is not null;--> statement-breakpoint
CREATE INDEX "auth_federation_attempt_provider_idx" ON "app"."auth_federation_attempts" USING btree ("organization_id","provider_id");--> statement-breakpoint
CREATE INDEX "auth_federation_attempt_domain_idx" ON "app"."auth_federation_attempts" USING btree ("organization_id","domain_id");--> statement-breakpoint
CREATE INDEX "auth_federation_attempt_expiry_idx" ON "app"."auth_federation_attempts" USING btree ("expires_at","id");--> statement-breakpoint
CREATE INDEX "auth_organization_workspace_org_idx" ON "app"."auth_organization_workspaces" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "auth_provider_checks_provider_idx" ON "app"."auth_provider_checks" USING btree ("organization_id","provider_id");--> statement-breakpoint
CREATE INDEX "auth_provider_organization_idx" ON "app"."auth_providers" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "app"."auth_sessions" ADD CONSTRAINT "auth_session_federation_provider_fk" FOREIGN KEY ("federation_provider_id") REFERENCES "app"."auth_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_sessions_federation_provider_idx" ON "app"."auth_sessions" USING btree ("federation_provider_id","id");--> statement-breakpoint
ALTER TABLE "app"."auth_sessions" ADD CONSTRAINT "auth_session_authentication_proof_valid" CHECK ((authentication_method in ('credential','social') AND federation_provider_id is null AND federation_provider_revision is null) OR (authentication_method='organization' AND federation_provider_id is not null AND federation_provider_revision is not null AND federation_provider_revision>0));
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE,DELETE ON app.auth_organizations,app.auth_organization_workspaces,app.auth_domains,app.auth_providers,app.auth_provider_checks,app.auth_federation_attempts TO {{app_role}};
GRANT SELECT,DELETE ON app.auth_organizations,app.auth_organization_workspaces,app.auth_domains,app.auth_providers,app.auth_provider_checks,app.auth_federation_attempts TO {{maintenance_role}};
GRANT SELECT(id,provider_id),DELETE ON app.auth_accounts TO {{maintenance_role}};

GRANT UPDATE(verified_session_id) ON app.workspace_invitation_acceptance_intents TO {{maintenance_role}};
