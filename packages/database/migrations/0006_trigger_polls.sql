CREATE TABLE "app"."trigger_polls" (
	"trigger_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"seen_keys" "bytea"[],
	"next_poll_at" timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
	"retired_at" timestamp with time zone,
	"lease_owner" varchar(128),
	"lease_token" uuid,
	"lease_acquired_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
	CONSTRAINT "trigger_polls_pkey" PRIMARY KEY("workspace_id","trigger_id"),
	CONSTRAINT "trigger_polls_lease_valid" CHECK (((((lease_owner IS NULL) AND (lease_token IS NULL) AND (lease_acquired_at IS NULL) AND (lease_expires_at IS NULL)) OR ((lease_owner IS NOT NULL) AND (lease_token IS NOT NULL) AND (lease_acquired_at IS NOT NULL) AND (lease_expires_at IS NOT NULL) AND (lease_expires_at > lease_acquired_at) AND (lease_expires_at <= (lease_acquired_at + '00:05:00'::interval)))) IS TRUE))
);
--> statement-breakpoint
ALTER TABLE "app"."workflow_triggers" DROP CONSTRAINT "workflow_triggers_kind_valid";--> statement-breakpoint
ALTER TABLE "app"."workflow_runs" DROP CONSTRAINT "workflow_runs_trigger_type_valid";--> statement-breakpoint
ALTER TABLE "app"."trigger_polls" ADD CONSTRAINT "trigger_polls_trigger_fk" FOREIGN KEY ("workspace_id","trigger_id") REFERENCES "app"."workflow_triggers"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trigger_polls_due_idx" ON "app"."trigger_polls" USING btree ("next_poll_at","workspace_id","trigger_id") WHERE (retired_at IS NULL);--> statement-breakpoint
ALTER TABLE "app"."workflow_triggers" ADD CONSTRAINT "workflow_triggers_kind_valid" CHECK (((kind)::text = ANY (ARRAY[('webhook'::character varying)::text, ('schedule'::character varying)::text, ('polling'::character varying)::text])));--> statement-breakpoint
ALTER TABLE "app"."workflow_runs" ADD CONSTRAINT "workflow_runs_trigger_type_valid" CHECK (((trigger_type)::text = ANY (ARRAY[('test'::character varying)::text,('form'::character varying)::text, ('workflow_error'::character varying)::text, ('api'::character varying)::text, ('manual'::character varying)::text, ('replay'::character varying)::text, ('schedule'::character varying)::text, ('polling'::character varying)::text, ('webhook'::character varying)::text, ('workflow_call'::character varying)::text])));

ALTER TABLE app.trigger_polls ENABLE ROW LEVEL SECURITY;
CREATE POLICY trigger_polls_workspace_scope ON app.trigger_polls TO {{app_role}}
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT ON app.trigger_polls TO {{app_role}};
GRANT UPDATE (seen_keys, next_poll_at, retired_at, lease_owner, lease_token,
  lease_acquired_at, lease_expires_at, updated_at) ON app.trigger_polls TO {{app_role}};
GRANT SELECT (workspace_id, trigger_id, next_poll_at, retired_at, lease_token, lease_expires_at),
  UPDATE (lease_owner, lease_token, lease_acquired_at, lease_expires_at, updated_at),
  DELETE ON app.trigger_polls TO {{maintenance_role}};

-- Like schedule claims, this returns a bounded lease page. Poll config and
-- progress are read only after opening a tenant-scoped transaction.
CREATE FUNCTION app.claim_due_trigger_polls(p_lease_owner character varying, p_limit integer, p_lease_seconds integer)
RETURNS TABLE(trigger_id uuid, workspace_id uuid, lease_token uuid, lease_expires_at timestamptz, observed_at timestamptz)
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'app', 'pg_temp'
SET row_security TO 'on'
AS $$
DECLARE v_observed_at timestamptz := clock_timestamp();
BEGIN
  IF p_lease_owner IS NULL OR length(p_lease_owner)<1 OR length(p_lease_owner)>128
    OR p_limit IS NULL OR p_limit<1 OR p_limit>100
    OR p_lease_seconds IS NULL OR p_lease_seconds<1 OR p_lease_seconds>300 THEN
    RAISE EXCEPTION 'invalid polling claim bounds' USING ERRCODE='22023';
  END IF;
  RETURN QUERY WITH due AS (
    SELECT poll.workspace_id, poll.trigger_id
    FROM app.trigger_polls poll
    JOIN app.workflow_triggers trigger ON trigger.workspace_id=poll.workspace_id AND trigger.id=poll.trigger_id
    JOIN app.workflows workflow ON workflow.workspace_id=trigger.workspace_id AND workflow.id=trigger.workflow_id
    JOIN app.workspaces workspace ON workspace.id=poll.workspace_id
    WHERE poll.retired_at IS NULL AND poll.next_poll_at<=v_observed_at
      AND (poll.lease_expires_at IS NULL OR poll.lease_expires_at<=v_observed_at)
      AND trigger.status='active' AND workflow.published_version_id=trigger.workflow_version_id
      AND workspace.status='active' AND workflow.lifecycle_status='active'
      AND workflow.activation_status IN ('active','degraded') AND workflow.trigger_pause_state<>'paused'
    ORDER BY poll.next_poll_at,poll.workspace_id,poll.trigger_id
    LIMIT p_limit FOR UPDATE OF poll SKIP LOCKED
  )
  UPDATE app.trigger_polls poll
  SET lease_owner=p_lease_owner,lease_token=gen_random_uuid(),lease_acquired_at=v_observed_at,
    lease_expires_at=v_observed_at+make_interval(secs=>p_lease_seconds),updated_at=v_observed_at
  FROM due WHERE poll.workspace_id=due.workspace_id AND poll.trigger_id=due.trigger_id
  RETURNING poll.trigger_id,poll.workspace_id,poll.lease_token,poll.lease_expires_at,v_observed_at;
END $$;
ALTER FUNCTION app.claim_due_trigger_polls(character varying, integer, integer) OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.claim_due_trigger_polls(character varying, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_due_trigger_polls(character varying, integer, integer) TO {{maintenance_role}};

CREATE OR REPLACE FUNCTION app.release_trigger_schedule_claim(p_trigger_id uuid, p_lease_token uuid) RETURNS boolean
    LANGUAGE sql
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
  WITH schedule AS (
    UPDATE app.trigger_schedules SET lease_owner=NULL,lease_token=NULL,lease_acquired_at=NULL,
      lease_expires_at=NULL,updated_at=clock_timestamp()
    WHERE trigger_id=p_trigger_id AND lease_token=p_lease_token RETURNING true AS released
  ), poll AS (
    UPDATE app.trigger_polls SET lease_owner=NULL,lease_token=NULL,lease_acquired_at=NULL,
      lease_expires_at=NULL,updated_at=statement_timestamp()
    WHERE trigger_id=p_trigger_id AND lease_token=p_lease_token AND NOT EXISTS (SELECT 1 FROM schedule)
    RETURNING true AS released
  )
  SELECT released FROM schedule UNION ALL SELECT released FROM poll
$$;
