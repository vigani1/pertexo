CREATE TABLE "app"."workflow_publication_requests" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"draft_revision" integer NOT NULL,
	"representation_tag" varchar(64) NOT NULL,
	"note" varchar(1000) NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"comment" varchar(1000),
	"published_version_id" uuid,
	"reused" boolean,
	CONSTRAINT "workflow_publication_requests_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "publication_requests_revision_valid" CHECK (draft_revision>0 AND representation_tag ~ '^"draft[.][A-Za-z0-9_-]{43}"$'),
	CONSTRAINT "publication_requests_note_valid" CHECK (length(btrim(note)) between 1 and 1000),
	CONSTRAINT "publication_requests_status_valid" CHECK (status in ('pending','approved','rejected','stale')),
	CONSTRAINT "publication_requests_expiry_valid" CHECK (expires_at>created_at),
	CONSTRAINT "publication_requests_decision_valid" CHECK (((status in ('pending','stale') AND decided_by IS NULL AND decided_at IS NULL AND comment IS NULL AND published_version_id IS NULL AND reused IS NULL) OR (status='rejected' AND decided_by IS NOT NULL AND decided_by<>requested_by AND decided_at IS NOT NULL AND published_version_id IS NULL AND reused IS NULL) OR (status='approved' AND decided_by IS NOT NULL AND decided_by<>requested_by AND decided_at IS NOT NULL AND published_version_id IS NOT NULL AND reused IS NOT NULL)) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "app"."workspace_inbox_threads" DROP CONSTRAINT "workspace_inbox_threads_subject_valid";--> statement-breakpoint
ALTER TABLE "app"."workspaces" ADD COLUMN "require_publish_approval" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."workspace_inbox_threads" ADD COLUMN "publication_request_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."workflow_publication_requests" ADD CONSTRAINT "publication_requests_workflow_fk" FOREIGN KEY ("workspace_id","workflow_id") REFERENCES "app"."workflows"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workflow_publication_requests" ADD CONSTRAINT "publication_requests_requester_fk" FOREIGN KEY ("requested_by") REFERENCES "app"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workflow_publication_requests" ADD CONSTRAINT "publication_requests_decider_fk" FOREIGN KEY ("decided_by") REFERENCES "app"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workflow_publication_requests" ADD CONSTRAINT "publication_requests_version_fk" FOREIGN KEY ("workspace_id","workflow_id","published_version_id") REFERENCES "app"."workflow_versions"("workspace_id","workflow_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "publication_requests_pending_unique" ON "app"."workflow_publication_requests" USING btree ("workspace_id","workflow_id") WHERE status='pending';--> statement-breakpoint
CREATE INDEX "publication_requests_recent_idx" ON "app"."workflow_publication_requests" USING btree ("workspace_id","workflow_id","created_at","id");--> statement-breakpoint
CREATE INDEX "publication_requests_expiry_idx" ON "app"."workflow_publication_requests" USING btree ("expires_at","id");--> statement-breakpoint
ALTER TABLE "app"."workspace_inbox_threads" ADD CONSTRAINT "workspace_inbox_threads_publication_request_fk" FOREIGN KEY ("workspace_id","publication_request_id") REFERENCES "app"."workflow_publication_requests"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workspace_inbox_threads" ADD CONSTRAINT "workspace_inbox_threads_subject_valid" CHECK (((notice_kind='publication_review_waiting' AND publication_request_id=subject_id AND workflow_id IS NOT NULL AND connection_id IS NULL AND task_id IS NULL AND capacity_limit IS NULL) OR (publication_request_id IS NULL AND ((notice_kind='limit_approaching' AND subject_id=id AND capacity_limit IN ('active','queue','artifact_bytes','artifact_count') AND workflow_id IS NULL AND connection_id IS NULL AND task_id IS NULL) OR (capacity_limit IS NULL AND ((notice_kind IN ('workflow_failure','workflow_auto_paused') AND workflow_id=subject_id AND connection_id IS NULL AND task_id IS NULL) OR (notice_kind='connection_attention' AND connection_id=subject_id AND workflow_id IS NULL AND task_id IS NULL) OR (notice_kind='approval_waiting' AND task_id=subject_id AND workflow_id IS NOT NULL AND connection_id IS NULL) OR (notice_kind='limit_reached' AND subject_id=workspace_id AND workflow_id IS NULL AND connection_id IS NULL AND task_id IS NULL)))))) IS TRUE);
--> statement-breakpoint
GRANT UPDATE(require_publish_approval) ON app.workspaces TO {{app_role}};
ALTER TABLE app.workflow_publication_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_publication_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY publication_requests_workspace_scope ON app.workflow_publication_requests TO {{app_role}}
 USING (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''))
 WITH CHECK (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''));
CREATE POLICY publication_requests_owner ON app.workflow_publication_requests TO {{owner_role}} USING (true) WITH CHECK (true);
CREATE POLICY publication_requests_maintenance ON app.workflow_publication_requests TO {{maintenance_role}} USING (true) WITH CHECK (true);
GRANT SELECT,INSERT,UPDATE ON app.workflow_publication_requests TO {{app_role}};
GRANT SELECT,DELETE ON app.workflow_publication_requests TO {{maintenance_role}};
