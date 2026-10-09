import { sql } from 'drizzle-orm';

import type { WorkspaceTransaction } from '../../tenant-access/transactions.js';
import type { ScheduleOccurrenceDisposition } from './misfire.js';

/** ADR 056: a paused workflow's occurrence is recorded without a run. */
export type RecordedScheduleOccurrence =
  ScheduleOccurrenceDisposition | 'paused';

/**
 * Whether the due instant falls in a pause, including a completed pause. It locks the
 * workflow row for the rest of the admission transaction, so a pause either
 * waits for this admission or is seen by it.
 */
export async function claimedScheduleWorkflowPaused(
  transaction: WorkspaceTransaction,
  claim: Readonly<{ trigger_id: string; lease_token: string }>,
  scheduledAt: Date,
): Promise<boolean> {
  await transaction.db.execute(sql`
    select 1 from app.workspaces where id=${transaction.workspaceId} for share`);
  const workflows = await transaction.db.execute<{
    workflow_id: string;
    paused: boolean;
  }>(sql`
    select workflow.id workflow_id, workflow.trigger_pause_state='paused' paused
    from app.trigger_schedules schedule
    join app.workflow_triggers trigger on trigger.id=schedule.trigger_id
    join app.workflows workflow
      on workflow.workspace_id=trigger.workspace_id and workflow.id=trigger.workflow_id
    where schedule.trigger_id=${claim.trigger_id}
      and schedule.lease_token=${claim.lease_token}
      and schedule.lease_expires_at>clock_timestamp()
    for share of workflow`);
  const workflow = workflows.rows[0];
  if (workflow === undefined) return false;
  if (workflow.paused) return true;
  // The latest pause that started by the due instant, if it had not resumed.
  const pauses = await transaction.db.execute<{ paused: boolean }>(sql`
    select ${scheduledAt}::timestamptz < resumed_at paused
    from app.workflow_trigger_pause_periods
    where workspace_id=${transaction.workspaceId}
      and workflow_id=${workflow.workflow_id}
      and paused_at<=${scheduledAt}
    order by paused_at desc limit 1`);
  return pauses.rows[0]?.paused === true;
}
