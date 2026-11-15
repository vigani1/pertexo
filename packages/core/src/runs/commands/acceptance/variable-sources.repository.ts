import { RUN_DETAILS_RETENTION_SQL } from '../../../shared/run-records/run-retention.repository.js';
import { and, eq, sql } from 'drizzle-orm';
import { workflowRuns } from '@pertexo/database/schema';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';

/** The replayed run's variable revision, and whether its details are still retained. */
export async function shareReplayVariableRevision(
  transaction: WorkspaceTransaction,
  sourceRunId: string,
) {
  const [source] = await transaction.db
    .select({
      revision: workflowRuns.variableSetRevision,
      retained: sql<boolean>`(${workflowRuns.detailsPurgedAt} IS NULL AND (${workflowRuns.completedAt} IS NULL OR ${workflowRuns.completedAt}>clock_timestamp()-${RUN_DETAILS_RETENTION_SQL}))`,
    })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.workspaceId, transaction.workspaceId),
        eq(workflowRuns.id, sourceRunId),
      ),
    )
    .limit(1)
    .for('share');
  return source;
}
