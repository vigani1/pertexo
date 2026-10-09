import type { PoolClient } from 'pg';

/** Acquire workflow authority before any configuration row is locked. */
export async function lockActiveTriggerWorkflow(
  client: PoolClient,
  workspaceId: string,
  triggerId: string,
  expectedWorkflowId?: string,
): Promise<boolean> {
  const result = await client.query(
    `select workflow.id from app.workflows workflow
      join app.workflow_triggers trigger
        on trigger.workspace_id=workflow.workspace_id
       and trigger.workflow_id=workflow.id
       and trigger.workflow_version_id=workflow.published_version_id
      where workflow.workspace_id=$1 and trigger.id=$2
        and workflow.lifecycle_status='active'
        and ($3::uuid is null or workflow.id=$3)
      for update of workflow`,
    [workspaceId, triggerId, expectedWorkflowId ?? null],
  );
  return result.rowCount === 1;
}

/** Pause effective admission without restoring or discarding configuration. */
export async function deactivateArchivedWorkflowTriggers(
  client: PoolClient,
  workspaceId: string,
  workflowId: string,
): Promise<void> {
  await client.query(
    `update app.workflow_triggers set status='disabled',health_status='disabled',
        last_error_code=null,reconciled_at=clock_timestamp(),updated_at=clock_timestamp()
      where workspace_id=$1 and workflow_id=$2`,
    [workspaceId, workflowId],
  );
  await client.query(
    `update app.trigger_schedules schedule
        set lease_owner=null,lease_token=null,lease_acquired_at=null,
            lease_expires_at=null,updated_at=clock_timestamp()
      where schedule.workspace_id=$1 and exists (
        select 1 from app.workflow_triggers trigger
         where trigger.workspace_id=schedule.workspace_id
           and trigger.id=schedule.trigger_id and trigger.workflow_id=$2)`,
    [workspaceId, workflowId],
  );
}
