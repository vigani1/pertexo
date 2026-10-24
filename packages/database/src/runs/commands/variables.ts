import { RUN_DETAILS_RETENTION_SQL } from '../data-policy.js';
import { and, eq, sql } from 'drizzle-orm';
import { workflowRuns } from '../../schema.js';
import type { WorkspaceTransaction } from '../../tenant-access/transactions.js';
import { captureWorkspaceVariableRevision } from '../../variables/settings.queries.js';
export class RunVariableSnapshotUnavailableError extends Error {
  override readonly name = 'RunVariableSnapshotUnavailableError';
  constructor() {
    super(
      'The source run’s workspace variables have expired. Start a new run to use current values.',
    );
  }
}
/** Replay precedes inheritance; neither may silently fall back to mutable workspace values. */
export async function variableRevisionForAcceptance(
  transaction: WorkspaceTransaction,
  sourceRunId: string | undefined,
  inherited?: number | null,
): Promise<number | null> {
  if (sourceRunId !== undefined) {
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
    if (!source?.retained) throw new RunVariableSnapshotUnavailableError();
    return source.revision;
  }
  return inherited === undefined
    ? captureWorkspaceVariableRevision(transaction)
    : inherited;
}
