CREATE TABLE "app"."auth_two_factors" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"failed_verification_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "auth_two_factors_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "app"."users" ADD COLUMN "two_factor_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."auth_two_factors" ADD CONSTRAINT "auth_two_factors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.auth_two_factors TO {{app_role}};
--> statement-breakpoint
GRANT UPDATE(two_factor_enabled) ON TABLE app.users TO {{app_role}};
