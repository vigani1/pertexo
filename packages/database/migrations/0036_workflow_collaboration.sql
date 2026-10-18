CREATE TABLE "app"."workflow_comments" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"author_id" uuid,
	"body" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"edited_at" timestamp with time zone,
	CONSTRAINT "workflow_comments_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "comment_text_valid" CHECK (length(btrim(body)) between 1 and 8000 and revision>0)
);
--> statement-breakpoint
CREATE TABLE "app"."workflow_comment_mentions" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"comment_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "workflow_comment_mentions_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "app"."workflow_presence_leases" (
	"workspace_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"tab_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"editing" boolean NOT NULL,
	"dirty" boolean NOT NULL,
	"base_revision" integer,
	"last_seen_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "workflow_presence_leases_workspace_id_workflow_id_user_id_tab_id_pk" PRIMARY KEY("workspace_id","workflow_id","user_id","tab_id"),
	CONSTRAINT "presence_shape_valid" CHECK (sequence>0 and sequence<=9007199254740991 and expires_at>last_seen_at and (base_revision is null or base_revision>0) and (not dirty or editing) and (not editing or base_revision is not null))
);
--> statement-breakpoint
CREATE TABLE "app"."workflow_comment_threads" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"step_id" varchar(128),
	"step_label" varchar(256),
	"status" varchar(16) DEFAULT 'open' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"comment_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "workflow_comment_threads_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "comment_thread_shape" CHECK (revision>0 and comment_count>=0 and status in ('open','resolved') and ((step_id is null and step_label is null) or (length(step_id)>0 and step_label is not null)))
);
--> statement-breakpoint
ALTER TABLE "app"."workspace_inbox_threads" DROP CONSTRAINT "workspace_inbox_threads_subject_valid";--> statement-breakpoint
ALTER TABLE "app"."workspace_inbox_threads" ADD COLUMN "comment_mention_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."workflow_comments" ADD CONSTRAINT "comment_thread_fk" FOREIGN KEY ("workspace_id","thread_id") REFERENCES "app"."workflow_comment_threads"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workflow_comments" ADD CONSTRAINT "comment_author_fk" FOREIGN KEY ("author_id") REFERENCES "app"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workflow_comment_mentions" ADD CONSTRAINT "comment_mention_comment_fk" FOREIGN KEY ("workspace_id","comment_id") REFERENCES "app"."workflow_comments"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workflow_comment_mentions" ADD CONSTRAINT "comment_mention_member_fk" FOREIGN KEY ("workspace_id","user_id") REFERENCES "app"."workspace_memberships"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workflow_presence_leases" ADD CONSTRAINT "presence_workflow_fk" FOREIGN KEY ("workspace_id","workflow_id") REFERENCES "app"."workflows"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workflow_presence_leases" ADD CONSTRAINT "presence_member_fk" FOREIGN KEY ("workspace_id","user_id") REFERENCES "app"."workspace_memberships"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workflow_comment_threads" ADD CONSTRAINT "comment_thread_workflow_fk" FOREIGN KEY ("workspace_id","workflow_id") REFERENCES "app"."workflows"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workflow_comment_threads" ADD CONSTRAINT "comment_thread_author_fk" FOREIGN KEY ("created_by") REFERENCES "app"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comments_thread_idx" ON "app"."workflow_comments" USING btree ("workspace_id","thread_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "comment_mention_person_unique" ON "app"."workflow_comment_mentions" USING btree ("workspace_id","comment_id","user_id");--> statement-breakpoint
CREATE INDEX "comment_mentions_recent_idx" ON "app"."workflow_comment_mentions" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "presence_expiry_idx" ON "app"."workflow_presence_leases" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "comment_threads_workflow_idx" ON "app"."workflow_comment_threads" USING btree ("workspace_id","workflow_id","id");--> statement-breakpoint
ALTER TABLE "app"."workspace_inbox_threads" ADD CONSTRAINT "workspace_inbox_threads_comment_mention_fk" FOREIGN KEY ("workspace_id","comment_mention_id") REFERENCES "app"."workflow_comment_mentions"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workspace_inbox_threads" ADD CONSTRAINT "workspace_inbox_threads_subject_valid" CHECK (((((notice_kind='publication_review_waiting' AND publication_request_id=subject_id AND workflow_id IS NOT NULL AND connection_id IS NULL AND task_id IS NULL AND capacity_limit IS NULL) OR (publication_request_id IS NULL AND ((notice_kind='limit_approaching' AND subject_id=id AND capacity_limit IN ('active','queue','artifact_bytes','artifact_count') AND workflow_id IS NULL AND connection_id IS NULL AND task_id IS NULL) OR (capacity_limit IS NULL AND ((notice_kind IN ('workflow_failure','workflow_auto_paused') AND workflow_id=subject_id AND connection_id IS NULL AND task_id IS NULL) OR (notice_kind='connection_attention' AND connection_id=subject_id AND workflow_id IS NULL AND task_id IS NULL) OR (notice_kind='approval_waiting' AND task_id=subject_id AND workflow_id IS NOT NULL AND connection_id IS NULL) OR (notice_kind='limit_reached' AND subject_id=workspace_id AND workflow_id IS NULL AND connection_id IS NULL AND task_id IS NULL)))))) and comment_mention_id is null) or (notice_kind='workflow_mention' and comment_mention_id=subject_id and workflow_id is not null and connection_id is null and task_id is null and publication_request_id is null and capacity_limit is null)) IS TRUE);
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE,DELETE ON app.workflow_comment_threads TO {{app_role}};
GRANT SELECT,DELETE ON app.workflow_comment_threads TO {{maintenance_role}};
ALTER TABLE app.workflow_comment_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_comment_threads FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_comment_threads_workspace ON app.workflow_comment_threads TO {{app_role}}
 USING (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),'')) WITH CHECK (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''));
CREATE POLICY workflow_comment_threads_owner ON app.workflow_comment_threads TO {{owner_role}} USING (true) WITH CHECK (true);
CREATE POLICY workflow_comment_threads_maintenance ON app.workflow_comment_threads TO {{maintenance_role}} USING (true) WITH CHECK (true);

--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE,DELETE ON app.workflow_comments TO {{app_role}};
GRANT SELECT,DELETE ON app.workflow_comments TO {{maintenance_role}};
ALTER TABLE app.workflow_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_comments FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_comments_workspace ON app.workflow_comments TO {{app_role}}
 USING (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),'')) WITH CHECK (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''));
CREATE POLICY workflow_comments_owner ON app.workflow_comments TO {{owner_role}} USING (true) WITH CHECK (true);
CREATE POLICY workflow_comments_maintenance ON app.workflow_comments TO {{maintenance_role}} USING (true) WITH CHECK (true);

--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE,DELETE ON app.workflow_comment_mentions TO {{app_role}};
GRANT SELECT,DELETE ON app.workflow_comment_mentions TO {{maintenance_role}};
ALTER TABLE app.workflow_comment_mentions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_comment_mentions FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_comment_mentions_workspace ON app.workflow_comment_mentions TO {{app_role}}
 USING (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),'')) WITH CHECK (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''));
CREATE POLICY workflow_comment_mentions_owner ON app.workflow_comment_mentions TO {{owner_role}} USING (true) WITH CHECK (true);
CREATE POLICY workflow_comment_mentions_maintenance ON app.workflow_comment_mentions TO {{maintenance_role}} USING (true) WITH CHECK (true);

--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE,DELETE ON app.workflow_presence_leases TO {{app_role}};
GRANT SELECT,DELETE ON app.workflow_presence_leases TO {{maintenance_role}};
ALTER TABLE app.workflow_presence_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_presence_leases FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_presence_leases_workspace ON app.workflow_presence_leases TO {{app_role}}
 USING (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),'')) WITH CHECK (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''));
CREATE POLICY workflow_presence_leases_owner ON app.workflow_presence_leases TO {{owner_role}} USING (true) WITH CHECK (true);
CREATE POLICY workflow_presence_leases_maintenance ON app.workflow_presence_leases TO {{maintenance_role}} USING (true) WITH CHECK (true);
