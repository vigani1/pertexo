CREATE TABLE "app"."notice_mail_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"preference_revision" integer NOT NULL,
	"default_revision" integer NOT NULL,
	"member_revision" integer NOT NULL,
	"recipient" varchar(320) NOT NULL,
	"window_key" varchar(64) NOT NULL,
	"item_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"released_at" timestamp with time zone,
	CONSTRAINT "notice_mail_batches_valid" CHECK (preference_revision>=0 AND default_revision>=0 AND member_revision>0 AND item_count BETWEEN 1 AND 100)
);
--> statement-breakpoint
CREATE TABLE "app"."notice_mail_items" (
	"workspace_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"revision" bigint NOT NULL,
	CONSTRAINT "notice_mail_items_pkey" PRIMARY KEY("workspace_id","batch_id","thread_id"),
	CONSTRAINT "notice_mail_items_revision_valid" CHECK (revision>0)
);
--> statement-breakpoint
CREATE TABLE "app"."notice_preferences" (
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"mode" varchar(16),
	"hour" integer DEFAULT 9 NOT NULL,
	"time_zone" varchar(128) DEFAULT 'UTC' NOT NULL,
	"changed_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"next_due_at" timestamp with time zone,
	"schedule_default_revision" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "notice_preferences_pkey" PRIMARY KEY("workspace_id","user_id"),
	CONSTRAINT "notice_preferences_valid" CHECK (revision>=0 AND (mode IS NULL OR mode IN ('off','immediate','hourly','daily')) AND hour BETWEEN 0 AND 23 AND schedule_default_revision>=0)
);
--> statement-breakpoint
CREATE TABLE "app"."notice_subscriptions" (
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"subject_kind" varchar(16) NOT NULL,
	"subject_id" uuid NOT NULL,
	"workflow_id" uuid,
	"connection_id" uuid,
	"revision" integer DEFAULT 0 NOT NULL,
	"followed" boolean DEFAULT false NOT NULL,
	"muted" boolean DEFAULT false NOT NULL,
	"changed_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "notice_subscriptions_pkey" PRIMARY KEY("workspace_id","user_id","subject_kind","subject_id"),
	CONSTRAINT "notice_subscriptions_valid" CHECK (revision>=0 AND ((subject_kind='workflow' AND workflow_id=subject_id AND connection_id IS NULL) OR (subject_kind='connection' AND connection_id=subject_id AND workflow_id IS NULL AND NOT followed)) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "app"."notice_workspace_settings" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"mode" varchar(16) DEFAULT 'off' NOT NULL,
	"hour" integer DEFAULT 9 NOT NULL,
	"time_zone" varchar(128) DEFAULT 'UTC' NOT NULL,
	"changed_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "notice_workspace_settings_valid" CHECK (revision>=0 AND mode IN ('off','immediate','hourly','daily') AND hour BETWEEN 0 AND 23)
);
--> statement-breakpoint
ALTER TABLE "app"."authentication_mail_deliveries" DROP CONSTRAINT "authentication_mail_purpose_valid";
--> statement-breakpoint
ALTER TABLE "app"."workspace_inbox_reads" DROP CONSTRAINT "workspace_inbox_reads_thread_fk";
--> statement-breakpoint
DROP INDEX "app"."workspace_inbox_threads_expiry_idx";
--> statement-breakpoint
DROP INDEX "app"."workspace_inbox_threads_recent_idx";
--> statement-breakpoint
ALTER TABLE "app"."workspace_inbox_reads" DROP CONSTRAINT "workspace_inbox_reads_pkey";
--> statement-breakpoint
ALTER TABLE "app"."workspace_inbox_threads" DROP CONSTRAINT "workspace_inbox_threads_pkey";
--> statement-breakpoint
ALTER TABLE "app"."workspace_inbox_threads" ALTER COLUMN "workflow_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "app"."workspace_inbox_threads" ALTER COLUMN "latest_run_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "app"."workspace_inbox_threads" ALTER COLUMN "latest_kind" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "app"."workspace_inbox_reads" ADD COLUMN "thread_id" uuid;
--> statement-breakpoint
ALTER TABLE "app"."workspace_inbox_threads" ADD COLUMN "id" uuid;
--> statement-breakpoint
ALTER TABLE "app"."workspace_inbox_threads" ADD COLUMN "notice_kind" varchar(32);
--> statement-breakpoint
ALTER TABLE "app"."workspace_inbox_threads" ADD COLUMN "subject_id" uuid;
--> statement-breakpoint
ALTER TABLE "app"."workspace_inbox_threads" ADD COLUMN "connection_id" uuid;
--> statement-breakpoint
ALTER TABLE "app"."workspace_inbox_threads" ADD COLUMN "task_id" uuid;
--> statement-breakpoint
ALTER TABLE "app"."workspace_inbox_threads" ADD COLUMN "active" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "app"."workspace_inbox_threads" ADD COLUMN "source_revision" varchar(128);
--> statement-breakpoint
UPDATE app.workspace_inbox_threads SET id=uuidv7(), notice_kind='workflow_failure', subject_id=workflow_id;
UPDATE app.workspace_inbox_reads seen SET thread_id=thread.id FROM app.workspace_inbox_threads thread WHERE thread.workspace_id=seen.workspace_id AND thread.workflow_id=seen.workflow_id;
ALTER TABLE app.workspace_inbox_threads ALTER COLUMN id SET NOT NULL;
ALTER TABLE app.workspace_inbox_threads ALTER COLUMN notice_kind SET NOT NULL;
ALTER TABLE app.workspace_inbox_threads ALTER COLUMN subject_id SET NOT NULL;
ALTER TABLE app.workspace_inbox_reads ALTER COLUMN thread_id SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "app"."workspace_inbox_reads" ADD CONSTRAINT "workspace_inbox_reads_pkey" PRIMARY KEY("workspace_id","user_id","thread_id");
--> statement-breakpoint
ALTER TABLE "app"."workspace_inbox_threads" ADD CONSTRAINT "workspace_inbox_threads_pkey" PRIMARY KEY("workspace_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "notice_mail_batches_window_unique" ON "app"."notice_mail_batches" USING btree ("workspace_id","user_id","window_key") WHERE released_at IS NULL;
--> statement-breakpoint
CREATE INDEX "notice_mail_batches_person_idx" ON "app"."notice_mail_batches" USING btree ("workspace_id","user_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "notice_mail_batches_workspace_unique" ON "app"."notice_mail_batches" USING btree ("workspace_id","id");
--> statement-breakpoint
CREATE INDEX "notice_mail_items_coverage_idx" ON "app"."notice_mail_items" USING btree ("workspace_id","thread_id","revision");
--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_inbox_threads_subject_unique" ON "app"."workspace_inbox_threads" USING btree ("workspace_id","notice_kind","subject_id");
--> statement-breakpoint
CREATE INDEX "workspace_inbox_threads_expiry_idx" ON "app"."workspace_inbox_threads" USING btree ("latest_occurred_at","workspace_id","id");
--> statement-breakpoint
CREATE INDEX "workspace_inbox_threads_recent_idx" ON "app"."workspace_inbox_threads" USING btree ("workspace_id","latest_occurred_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);
--> statement-breakpoint
ALTER TABLE "app"."notice_mail_batches" ADD CONSTRAINT "notice_mail_batches_delivery_fk" FOREIGN KEY ("id") REFERENCES "app"."authentication_mail_deliveries"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app"."notice_mail_batches" ADD CONSTRAINT "notice_mail_batches_member_fk" FOREIGN KEY ("workspace_id","user_id") REFERENCES "app"."workspace_memberships"("workspace_id","user_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app"."notice_mail_items" ADD CONSTRAINT "notice_mail_items_batch_fk" FOREIGN KEY ("workspace_id","batch_id") REFERENCES "app"."notice_mail_batches"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app"."notice_mail_items" ADD CONSTRAINT "notice_mail_items_thread_fk" FOREIGN KEY ("workspace_id","thread_id") REFERENCES "app"."workspace_inbox_threads"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app"."notice_preferences" ADD CONSTRAINT "notice_preferences_member_fk" FOREIGN KEY ("workspace_id","user_id") REFERENCES "app"."workspace_memberships"("workspace_id","user_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app"."notice_subscriptions" ADD CONSTRAINT "notice_subscriptions_member_fk" FOREIGN KEY ("workspace_id","user_id") REFERENCES "app"."workspace_memberships"("workspace_id","user_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app"."notice_subscriptions" ADD CONSTRAINT "notice_subscriptions_workflow_fk" FOREIGN KEY ("workspace_id","workflow_id") REFERENCES "app"."workflows"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app"."notice_subscriptions" ADD CONSTRAINT "notice_subscriptions_connection_fk" FOREIGN KEY ("workspace_id","connection_id") REFERENCES "app"."connections"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app"."notice_workspace_settings" ADD CONSTRAINT "notice_workspace_settings_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app"."workspace_inbox_reads" ADD CONSTRAINT "workspace_inbox_reads_thread_fk" FOREIGN KEY ("workspace_id","thread_id") REFERENCES "app"."workspace_inbox_threads"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app"."workspace_inbox_threads" ADD CONSTRAINT "workspace_inbox_threads_connection_fk" FOREIGN KEY ("workspace_id","connection_id") REFERENCES "app"."connections"("workspace_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app"."workspace_inbox_threads" ADD CONSTRAINT "workspace_inbox_threads_task_fk" FOREIGN KEY ("workspace_id","task_id") REFERENCES "app"."pending_run_tasks"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app"."authentication_mail_deliveries" ADD CONSTRAINT "authentication_mail_purpose_valid" CHECK (((purpose)::text = ANY (ARRAY[('verification'::character varying)::text, ('password_reset'::character varying)::text, ('email_change_confirmation'::character varying)::text, ('workspace_notice'::character varying)::text])));
--> statement-breakpoint
ALTER TABLE "app"."workspace_inbox_threads" ADD CONSTRAINT "workspace_inbox_threads_subject_valid" CHECK (((notice_kind IN ('workflow_failure','workflow_auto_paused') AND workflow_id=subject_id AND connection_id IS NULL AND task_id IS NULL) OR (notice_kind='connection_attention' AND connection_id=subject_id AND workflow_id IS NULL AND task_id IS NULL) OR (notice_kind='approval_waiting' AND task_id=subject_id AND workflow_id IS NOT NULL AND connection_id IS NULL) OR (notice_kind='limit_reached' AND subject_id=workspace_id AND workflow_id IS NULL AND connection_id IS NULL AND task_id IS NULL)) IS TRUE);
--> statement-breakpoint
ALTER TABLE "app"."workspace_inbox_threads" ADD CONSTRAINT "workspace_inbox_threads_failure_valid" CHECK (((notice_kind='workflow_failure' AND latest_run_id IS NOT NULL AND latest_kind IS NOT NULL) OR (notice_kind<>'workflow_failure' AND latest_run_id IS NULL AND latest_kind IS NULL)) IS TRUE);
--> statement-breakpoint
ALTER TABLE "app"."workspace_inbox_reads" DROP COLUMN "workflow_id";

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.fold_workspace_inbox_events(p_limit integer) RETURNS TABLE(workspace_id uuid, revision bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
#variable_conflict use_column
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'inbox fold limit must be between 1 and 1000' USING ERRCODE='22023';
  END IF;
  RETURN QUERY
  WITH picked AS MATERIALIZED (
    SELECT event.id,event.workspace_id,event.workflow_id,event.run_id,
           event.kind,event.occurred_at
      FROM app.workspace_inbox_events event
     ORDER BY event.created_at,event.id
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  ), grouped AS (
    SELECT picked.workspace_id,picked.workflow_id,count(*) AS occurrences,
           min(picked.occurred_at) AS first_at,max(picked.occurred_at) AS latest_at,
           (array_agg(picked.run_id ORDER BY picked.occurred_at DESC,picked.id DESC))[1] AS latest_run,
           (array_agg(picked.kind ORDER BY picked.occurred_at DESC,picked.id DESC))[1] AS latest_kind
      FROM picked JOIN app.workspaces workspace ON workspace.id=picked.workspace_id
     WHERE workspace.status IN ('active','suspended','pending_deletion')
     GROUP BY picked.workspace_id,picked.workflow_id
  ), folded AS (
    INSERT INTO app.workspace_inbox_threads AS thread (
      workspace_id,id,notice_kind,subject_id,workflow_id,revision,occurrence_count,first_occurred_at,
      latest_occurred_at,latest_run_id,latest_kind)
    SELECT grouped.workspace_id,uuidv7(),'workflow_failure',grouped.workflow_id,grouped.workflow_id,
           nextval('app.workspace_inbox_revision_seq'),grouped.occurrences,
           grouped.first_at,grouped.latest_at,grouped.latest_run,grouped.latest_kind
      FROM grouped ORDER BY grouped.workspace_id,grouped.workflow_id
    ON CONFLICT (workspace_id,notice_kind,subject_id) DO UPDATE SET
      revision=excluded.revision,
      occurrence_count=CASE
        WHEN thread.latest_occurred_at<=statement_timestamp()-interval '720 hours'
        THEN excluded.occurrence_count
        ELSE thread.occurrence_count+excluded.occurrence_count END,
      first_occurred_at=CASE
        WHEN thread.latest_occurred_at<=statement_timestamp()-interval '720 hours'
        THEN excluded.first_occurred_at
        ELSE least(thread.first_occurred_at,excluded.first_occurred_at) END,
      latest_occurred_at=greatest(thread.latest_occurred_at,excluded.latest_occurred_at),
      latest_run_id=CASE WHEN excluded.latest_occurred_at>=thread.latest_occurred_at
        THEN excluded.latest_run_id ELSE thread.latest_run_id END,
      latest_kind=CASE WHEN excluded.latest_occurred_at>=thread.latest_occurred_at
        THEN excluded.latest_kind ELSE thread.latest_kind END,
      updated_at=clock_timestamp()
    RETURNING thread.workspace_id,thread.revision
  ), consumed AS (
    DELETE FROM app.workspace_inbox_events event USING picked
     WHERE event.id=picked.id
  )
  SELECT folded.workspace_id,max(folded.revision)::bigint
    FROM folded GROUP BY folded.workspace_id;
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.workspace_inbox_recipient_eligible(p_workspace_id uuid,p_user_id uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path TO pg_catalog,app AS $$
 SELECT p_workspace_id::text=NULLIF(current_setting('app.workspace_id',true),'') AND p_user_id::text=NULLIF(current_setting('app.actor_id',true),'') AND EXISTS(
 SELECT 1 FROM app.workspace_memberships m JOIN app.workspaces w ON w.id=m.workspace_id JOIN app.users u ON u.id=m.user_id WHERE m.workspace_id=p_workspace_id AND m.user_id=p_user_id AND m.status='active' AND w.status='active' AND u.status='active');
$$;
-- A data visibility fence; live task decisions and mail use the TypeScript task owner.
CREATE FUNCTION app.workspace_notice_visible(p_workspace_id uuid,p_kind varchar,p_workflow_id uuid,p_connection_id uuid,p_task_id uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path TO pg_catalog,app AS $$
 SELECT app.workspace_inbox_recipient_eligible(p_workspace_id,NULLIF(current_setting('app.actor_id',true),'')::uuid) AND EXISTS(
 SELECT 1 FROM app.workspace_memberships member WHERE member.workspace_id=p_workspace_id AND member.user_id=NULLIF(current_setting('app.actor_id',true),'')::uuid
 AND NOT EXISTS(SELECT 1 FROM app.notice_subscriptions sub WHERE sub.workspace_id=p_workspace_id AND sub.user_id=member.user_id AND sub.muted AND ((sub.subject_kind='workflow' AND sub.subject_id=p_workflow_id) OR (sub.subject_kind='connection' AND sub.subject_id=p_connection_id)))
 AND ( (p_kind IN ('workflow_failure','workflow_auto_paused') AND (member.role IN ('owner','admin','operator') OR EXISTS(SELECT 1 FROM app.notice_subscriptions sub WHERE sub.workspace_id=p_workspace_id AND sub.user_id=member.user_id AND sub.subject_kind='workflow' AND sub.subject_id=p_workflow_id AND sub.followed)))
 OR (p_kind='connection_attention' AND member.role IN ('owner','admin'))
 OR (p_kind='limit_reached' AND member.role IN ('owner','admin','operator'))
 OR (p_kind='approval_waiting' AND EXISTS(SELECT 1 FROM app.pending_run_tasks task JOIN app.workflow_runs run ON run.workspace_id=task.workspace_id AND run.id=task.run_id WHERE task.workspace_id=p_workspace_id AND task.id=p_task_id AND task.kind='approval' AND task.status='pending' AND task.expires_at>statement_timestamp() AND run.status IN ('queued','running','waiting') AND run.cancel_requested_at IS NULL AND (run.deadline_at IS NULL OR run.deadline_at>statement_timestamp()) AND run.started_by IS DISTINCT FROM member.user_id AND ((task.config->'audience'->'roles') ? member.role::text OR (task.config->'audience'->'memberIds') ? member.user_id::text))) ));
$$;
REVOKE ALL ON FUNCTION app.workspace_notice_visible(uuid,varchar,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.workspace_notice_visible(uuid,varchar,uuid,uuid,uuid) TO {{app_role}};
DROP POLICY workspace_inbox_threads_recipient_select ON app.workspace_inbox_threads;
CREATE POLICY workspace_inbox_threads_recipient_select ON app.workspace_inbox_threads FOR SELECT TO {{app_role}} USING(
 workspace_id::text=NULLIF(current_setting('app.workspace_id',true),'') AND (NULLIF(current_setting('app.actor_id',true),'') IS NULL OR (active AND (notice_kind<>'workflow_failure' OR latest_occurred_at>statement_timestamp()-interval '720 hours') AND app.workspace_notice_visible(workspace_id,notice_kind,workflow_id,connection_id,task_id))));
CREATE POLICY workspace_inbox_threads_worker_insert ON app.workspace_inbox_threads FOR INSERT TO {{app_role}} WITH CHECK(workspace_id::text=NULLIF(current_setting('app.workspace_id',true),'') AND NULLIF(current_setting('app.actor_id',true),'') IS NULL);
CREATE POLICY workspace_inbox_threads_worker_update ON app.workspace_inbox_threads FOR UPDATE TO {{app_role}} USING(workspace_id::text=NULLIF(current_setting('app.workspace_id',true),'') AND NULLIF(current_setting('app.actor_id',true),'') IS NULL) WITH CHECK(workspace_id::text=NULLIF(current_setting('app.workspace_id',true),'') AND NULLIF(current_setting('app.actor_id',true),'') IS NULL);
GRANT INSERT,UPDATE ON app.workspace_inbox_threads TO {{app_role}};

ALTER TABLE app.notice_workspace_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.notice_workspace_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY notice_workspace_settings_scope ON app.notice_workspace_settings TO {{app_role}} USING(workspace_id::text=NULLIF(current_setting('app.workspace_id',true),'')) WITH CHECK(workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''));
CREATE POLICY notice_workspace_settings_owner ON app.notice_workspace_settings TO {{owner_role}} USING(true) WITH CHECK(true);
CREATE POLICY notice_workspace_settings_maintenance ON app.notice_workspace_settings TO {{maintenance_role}} USING(true) WITH CHECK(true);
GRANT SELECT,INSERT,UPDATE,DELETE ON app.notice_workspace_settings TO {{app_role}};
GRANT SELECT,DELETE ON app.notice_workspace_settings TO {{maintenance_role}};

ALTER TABLE app.notice_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.notice_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY notice_preferences_scope ON app.notice_preferences TO {{app_role}} USING(workspace_id::text=NULLIF(current_setting('app.workspace_id',true),'') AND (NULLIF(current_setting('app.actor_id',true),'') IS NULL OR user_id::text=current_setting('app.actor_id',true))) WITH CHECK(workspace_id::text=NULLIF(current_setting('app.workspace_id',true),'') AND (NULLIF(current_setting('app.actor_id',true),'') IS NULL OR user_id::text=current_setting('app.actor_id',true)));
CREATE POLICY notice_preferences_owner ON app.notice_preferences TO {{owner_role}} USING(true) WITH CHECK(true);
CREATE POLICY notice_preferences_maintenance ON app.notice_preferences TO {{maintenance_role}} USING(true) WITH CHECK(true);
GRANT SELECT,INSERT,UPDATE,DELETE ON app.notice_preferences TO {{app_role}};
GRANT SELECT,DELETE ON app.notice_preferences TO {{maintenance_role}};

ALTER TABLE app.notice_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.notice_subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY notice_subscriptions_scope ON app.notice_subscriptions TO {{app_role}} USING(workspace_id::text=NULLIF(current_setting('app.workspace_id',true),'') AND (NULLIF(current_setting('app.actor_id',true),'') IS NULL OR user_id::text=current_setting('app.actor_id',true))) WITH CHECK(workspace_id::text=NULLIF(current_setting('app.workspace_id',true),'') AND (NULLIF(current_setting('app.actor_id',true),'') IS NULL OR user_id::text=current_setting('app.actor_id',true)));
CREATE POLICY notice_subscriptions_owner ON app.notice_subscriptions TO {{owner_role}} USING(true) WITH CHECK(true);
CREATE POLICY notice_subscriptions_maintenance ON app.notice_subscriptions TO {{maintenance_role}} USING(true) WITH CHECK(true);
GRANT SELECT,INSERT,UPDATE,DELETE ON app.notice_subscriptions TO {{app_role}};
GRANT SELECT,DELETE ON app.notice_subscriptions TO {{maintenance_role}};

ALTER TABLE app.notice_mail_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.notice_mail_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY notice_mail_batches_scope ON app.notice_mail_batches TO {{app_role}} USING(workspace_id::text=NULLIF(current_setting('app.workspace_id',true),'') AND (NULLIF(current_setting('app.actor_id',true),'') IS NULL OR user_id::text=current_setting('app.actor_id',true))) WITH CHECK(workspace_id::text=NULLIF(current_setting('app.workspace_id',true),'') AND (NULLIF(current_setting('app.actor_id',true),'') IS NULL OR user_id::text=current_setting('app.actor_id',true)));
CREATE POLICY notice_mail_batches_owner ON app.notice_mail_batches TO {{owner_role}} USING(true) WITH CHECK(true);
CREATE POLICY notice_mail_batches_maintenance ON app.notice_mail_batches TO {{maintenance_role}} USING(true) WITH CHECK(true);
GRANT SELECT,INSERT,UPDATE,DELETE ON app.notice_mail_batches TO {{app_role}};
GRANT SELECT,DELETE ON app.notice_mail_batches TO {{maintenance_role}};

ALTER TABLE app.notice_mail_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.notice_mail_items FORCE ROW LEVEL SECURITY;
CREATE POLICY notice_mail_items_scope ON app.notice_mail_items TO {{app_role}} USING(workspace_id::text=NULLIF(current_setting('app.workspace_id',true),'') AND (NULLIF(current_setting('app.actor_id',true),'') IS NULL OR EXISTS(SELECT 1 FROM app.notice_mail_batches batch WHERE batch.workspace_id=notice_mail_items.workspace_id AND batch.id=notice_mail_items.batch_id AND batch.user_id::text=current_setting('app.actor_id',true)))) WITH CHECK(workspace_id::text=NULLIF(current_setting('app.workspace_id',true),'') AND (NULLIF(current_setting('app.actor_id',true),'') IS NULL OR EXISTS(SELECT 1 FROM app.notice_mail_batches batch WHERE batch.workspace_id=notice_mail_items.workspace_id AND batch.id=notice_mail_items.batch_id AND batch.user_id::text=current_setting('app.actor_id',true))));
CREATE POLICY notice_mail_items_owner ON app.notice_mail_items TO {{owner_role}} USING(true) WITH CHECK(true);
CREATE POLICY notice_mail_items_maintenance ON app.notice_mail_items TO {{maintenance_role}} USING(true) WITH CHECK(true);
GRANT SELECT,INSERT,UPDATE,DELETE ON app.notice_mail_items TO {{app_role}};
GRANT SELECT,DELETE ON app.notice_mail_items TO {{maintenance_role}};

-- Removal/departure already passed the TypeScript authority fence in this transaction.
CREATE FUNCTION app.clear_removed_member_notices(p_workspace_id uuid,p_user_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog,app,pg_temp SET row_security TO on AS $$
BEGIN
 IF p_workspace_id::text IS DISTINCT FROM NULLIF(current_setting('app.workspace_id',true),'') OR NOT EXISTS(SELECT 1 FROM app.workspace_memberships WHERE workspace_id=p_workspace_id AND user_id=p_user_id AND status='removed') THEN RAISE EXCEPTION 'removed membership required' USING ERRCODE='42501'; END IF;
 DELETE FROM app.notice_preferences WHERE workspace_id=p_workspace_id AND user_id=p_user_id;
 DELETE FROM app.notice_subscriptions WHERE workspace_id=p_workspace_id AND user_id=p_user_id;
 DELETE FROM app.workspace_inbox_reads WHERE workspace_id=p_workspace_id AND user_id=p_user_id;
END $$;
REVOKE ALL ON FUNCTION app.clear_removed_member_notices(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.clear_removed_member_notices(uuid,uuid) TO {{app_role}};

--> statement-breakpoint
ALTER TABLE "app"."workspace_inbox_threads" ADD CONSTRAINT "workspace_inbox_threads_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE restrict ON UPDATE no action;
GRANT USAGE ON SEQUENCE app.workspace_inbox_revision_seq TO {{app_role}};
