import { sql } from 'drizzle-orm';

import type { WorkspaceTransaction } from '../tenant-access/workspace.js';
import type { ScheduleOccurrenceDisposition } from './schedule-misfire.js';

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
  const result = await transaction.db.execute<{ paused: boolean }>(sql`
    select app.schedule_claim_workflow_paused(
      ${claim.trigger_id},${claim.lease_token},${scheduledAt}) paused
  `);
  return result.rows[0]?.paused === true;
}
