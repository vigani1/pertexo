import { alias } from 'drizzle-orm/pg-core';
import {
  workspaces,
  workflows as workflowRecords,
  workflowTriggers,
  triggerSchedules,
  workflowTriggerPausePeriods,
} from '@pertexo/database/schema';
import { and, desc, eq, sql } from 'drizzle-orm';

import type { WorkspaceTransaction } from '@pertexo/database/primitives';

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
  await transaction.db
    .select({ one: sql`1` })
    .from(workspaces)
    .where(eq(workspaces.id, transaction.workspaceId))
    .for('share');
  const workflow = alias(workflowRecords, 'workflow');
  const states = await transaction.db
    .select({
      workflow_id: workflow.id,
      paused: sql<boolean>`${workflow.triggerPauseState}='paused'`,
    })
    .from(triggerSchedules)
    .innerJoin(
      workflowTriggers,
      eq(workflowTriggers.id, triggerSchedules.triggerId),
    )
    .innerJoin(
      workflow,
      and(
        eq(workflow.workspaceId, workflowTriggers.workspaceId),
        eq(workflow.id, workflowTriggers.workflowId),
      ),
    )
    .where(
      and(
        eq(triggerSchedules.triggerId, claim.trigger_id),
        eq(triggerSchedules.leaseToken, claim.lease_token),
        sql`${triggerSchedules.leaseExpiresAt}>clock_timestamp()`,
      ),
    )
    .for('share', { of: workflow });
  const state = states[0];
  if (state === undefined) return false;
  if (state.paused) return true;
  // The latest pause that started by the due instant, if it had not resumed.
  const pauses = await transaction.db
    .select({
      paused: sql<
        boolean | null
      >`${scheduledAt}::timestamptz<${workflowTriggerPausePeriods.resumedAt}`,
    })
    .from(workflowTriggerPausePeriods)
    .where(
      and(
        eq(workflowTriggerPausePeriods.workspaceId, transaction.workspaceId),
        eq(workflowTriggerPausePeriods.workflowId, state.workflow_id),
        sql`${workflowTriggerPausePeriods.pausedAt}<=${scheduledAt}`,
      ),
    )
    .orderBy(desc(workflowTriggerPausePeriods.pausedAt))
    .limit(1);
  return pauses[0]?.paused ?? false;
}
