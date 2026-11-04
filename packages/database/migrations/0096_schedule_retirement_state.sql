ALTER TABLE "app"."trigger_schedules" ADD COLUMN "retired_at" timestamp with time zone;--> statement-breakpoint
-- Retirement is separate from the person's operational choice. Legacy
-- retirement overwrote that choice; the latest command for the same step
-- recovers it, with enabled being the original publication default.
DO $$
DECLARE workspace uuid; prior_workspace text;
BEGIN
  prior_workspace := current_setting('app.workspace_id',true);
  FOR workspace IN SELECT id FROM app.workspaces ORDER BY id LOOP
    PERFORM set_config('app.workspace_id',workspace::text,true);
WITH intent AS (
  SELECT DISTINCT ON (t.workspace_id,t.workflow_id,t.node_id)
    t.workspace_id,t.workflow_id,t.node_id,a.action
  FROM app.workflow_triggers t
  JOIN app.audit_events a ON a.workspace_id=t.workspace_id
    AND a.target_id=t.id AND a.target_type='schedule_trigger'
    AND a.action IN ('schedule_trigger.enabled','schedule_trigger.disabled')
  WHERE t.workspace_id=workspace
  ORDER BY t.workspace_id,t.workflow_id,t.node_id,a.occurred_at DESC,a.id DESC
)
UPDATE app.trigger_schedules s SET
  retired_at=coalesce(t.reconciled_at,t.updated_at),
  status=CASE WHEN intent.action='schedule_trigger.disabled' THEN 'disabled' ELSE 'enabled' END,
  health_status=CASE WHEN intent.action='schedule_trigger.disabled' THEN 'disabled' ELSE 'healthy' END
FROM app.workflow_triggers t
JOIN app.workflows w ON w.workspace_id=t.workspace_id AND w.id=t.workflow_id
LEFT JOIN intent ON intent.workspace_id=t.workspace_id
  AND intent.workflow_id=t.workflow_id AND intent.node_id=t.node_id
WHERE s.workspace_id=workspace AND s.trigger_id=t.id
  AND t.workflow_version_id IS DISTINCT FROM w.published_version_id;
  END LOOP;
  PERFORM set_config('app.workspace_id',coalesce(prior_workspace,''),true);
END $$;
--> statement-breakpoint
GRANT UPDATE(retired_at,anchor_at) ON app.trigger_schedules TO {{app_role}};
