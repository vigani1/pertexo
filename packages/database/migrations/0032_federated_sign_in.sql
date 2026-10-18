CREATE TABLE "app"."auth_sign_in_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"state_digest" "bytea" NOT NULL,
	"browser_digest" "bytea" NOT NULL,
	"return_path" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "auth_sign_in_state_unique" UNIQUE("state_digest"),
	CONSTRAINT "auth_sign_in_digest_valid" CHECK (octet_length(state_digest)=32 AND octet_length(browser_digest)=32),
	CONSTRAINT "auth_sign_in_provider_valid" CHECK (provider ~ '^[a-z][a-z0-9_-]{0,31}$'),
	CONSTRAINT "auth_sign_in_path_valid" CHECK (length(return_path) between 1 and 128 AND left(return_path,1)='/'),
	CONSTRAINT "auth_sign_in_expiry_valid" CHECK (expires_at>created_at)
);
--> statement-breakpoint
ALTER TABLE "app"."identity_security_audit_facts" DROP CONSTRAINT "identity_security_audit_event_valid";--> statement-breakpoint
CREATE INDEX "auth_sign_in_expiry_idx" ON "app"."auth_sign_in_attempts" USING btree ("expires_at","id");--> statement-breakpoint
ALTER TABLE "app"."identity_security_audit_facts" ADD CONSTRAINT "identity_security_audit_event_valid" CHECK (((event_type)::text = ANY (ARRAY['email.initial_verified'::text, 'email.old_confirmed'::text, 'email.change_verified'::text, 'method.linked'::text, 'method.unlinked'::text, 'password.changed'::text, 'password.configured'::text, 'password.reset'::text, 'profile.display_name_changed'::text, 'session.signed_in'::text])));
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON app.auth_sign_in_attempts TO {{app_role}};
GRANT SELECT,DELETE ON app.auth_sign_in_attempts TO {{maintenance_role}};
