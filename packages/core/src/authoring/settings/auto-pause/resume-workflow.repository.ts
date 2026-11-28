import type { PoolClient } from 'pg';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  workflowFailureStreaks,
  workflows,
  workflowTriggerPausePeriods,
} from '@pertexo/database/schema';
import { readDatabaseClockText } from '../../../shared/database-clock.repository.js';
import {
  workflowProjection,
  type WorkflowRow,
} from './auto-pause-state.repository.js';

export async function writeWorkflowResume(
  client: PoolClient,
  workspaceId: string,
  workflowId: string,
  current: WorkflowRow,
) {
  // Outcomes that ended before the resume no longer count.
  const resumedAt = await readDatabaseClockText(client);
  const db = drizzle(client);
  // The paused-state CHECK guarantees the retained pause start is present.
  await db
    .insert(workflowTriggerPausePeriods)
    .values({
      workspaceId,
      workflowId,
      pauseRevision: BigInt(current.triggerPauseRevision),
      pausedBy: current.triggerPausedBy,
      pausedAt: sql<string>`${current.pausedAt}::timestamptz`,
      resumedAt,
    })
    .catch(rethrowQueryFailure);
  await db
    .insert(workflowFailureStreaks)
    .values({
      workspaceId,
      workflowId,
      consecutiveFailures: 0,
      legacyFailures: 0,
      resumedAfter: resumedAt,
    })
    .onConflictDoUpdate({
      target: [
        workflowFailureStreaks.workspaceId,
        workflowFailureStreaks.workflowId,
      ],
      set: {
        consecutiveFailures: 0,
        legacyFailures: 0,
        lastRunId: null,
        lastEndedAt: null,
        resumedAfter: resumedAt,
        updatedAt: sql`clock_timestamp()`,
      },
    })
    .catch(rethrowQueryFailure);
  const [updated] = await db
    .update(workflows)
    .set({
      triggerPauseState: 'none',
      triggerPausedAt: null,
      triggerPauseReason: null,
      triggerPausedBy: null,
      triggerPauseFailures: null,
      triggerPauseLastRunId: null,
      triggerPausePollTriggerId: null,
      triggerPausePollErrorCode: null,
      triggerPauseRevision: sql`${workflows.triggerPauseRevision}+1`,
    })
    .where(
      and(eq(workflows.workspaceId, workspaceId), eq(workflows.id, workflowId)),
    )
    .returning(workflowProjection)
    .catch(rethrowQueryFailure);
  return updated ?? current;
}
