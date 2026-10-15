import { and, eq, sql } from 'drizzle-orm';
import {
  workspaceVariableSnapshotSchema,
  type WorkspaceVariableSnapshot,
} from '@pertexo/workflow-model';
import { workflowRuns } from '../../schema.js';
import type { WorkspaceTransaction } from '../../tenant-access/transactions.js';
import { readWorkspaceVariables } from '../../tenant-access/variables/read.js';
export class RunVariableSnapshotUnavailableError extends Error {
  override readonly name = 'RunVariableSnapshotUnavailableError';
  constructor() {
    super(
      'The source run’s workspace variables have expired. Start a new run to use current values.',
    );
  }
}
/** Replay precedes inheritance; neither may silently fall back to mutable workspace values. */
export async function variablesForAcceptance(
  transaction: WorkspaceTransaction,
  sourceRunId: string | undefined,
  inherited?: WorkspaceVariableSnapshot,
): Promise<WorkspaceVariableSnapshot> {
  if (sourceRunId !== undefined) {
    const [source] = await transaction.db
      .select({
        snapshot: workflowRuns.variableSnapshot,
        retained: sql<boolean>`(${workflowRuns.completedAt} IS NULL OR ${workflowRuns.completedAt}>clock_timestamp()-interval '30 days')`,
      })
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.workspaceId, transaction.workspaceId),
          eq(workflowRuns.id, sourceRunId),
        ),
      )
      .limit(1);
    if (source === undefined || source.snapshot === null || !source.retained)
      throw new RunVariableSnapshotUnavailableError();
    return workspaceVariableSnapshotSchema.parse(source.snapshot);
  }
  return inherited ?? readWorkspaceVariables(transaction);
}
