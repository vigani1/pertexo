import { and, eq, sql } from 'drizzle-orm';
import { RUN_VALUE_LIMITS, type RunValues } from '@pertexo/node-sdk';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import { workflowRunValues, workflowRuns } from '@pertexo/database/schema';
import { expiredRunSql } from '../../shared/run-records/run-retention.repository.js';
import { generatePersistedId } from '@pertexo/database/platform';

/** The live run's values by key, one past the cap so an overfull set shows. */
export async function readRunValueRows(
  transaction: WorkspaceTransaction,
  runId: string,
): Promise<readonly Readonly<{ key: string; value: string }>[]> {
  return transaction.db
    .select({ key: workflowRunValues.key, value: workflowRunValues.value })
    .from(workflowRunValues)
    .innerJoin(
      workflowRuns,
      and(
        eq(workflowRuns.workspaceId, workflowRunValues.workspaceId),
        eq(workflowRuns.id, workflowRunValues.workflowRunId),
      ),
    )
    .where(
      and(
        eq(workflowRunValues.workspaceId, transaction.workspaceId),
        eq(workflowRunValues.workflowRunId, runId),
        sql`not (${expiredRunSql('workflow_runs')})`,
      ),
    )
    .orderBy(workflowRunValues.key)
    .limit(RUN_VALUE_LIMITS.pairs + 1);
}

export async function insertRunValues(
  transaction: WorkspaceTransaction,
  runId: string,
  values: RunValues,
): Promise<void> {
  const pairs = Object.entries(values);
  if (pairs.length === 0) return;
  await transaction.db.insert(workflowRunValues).values(
    pairs.map(([key, value]) => ({
      id: generatePersistedId(),
      workspaceId: transaction.workspaceId,
      workflowRunId: runId,
      key,
      value,
    })),
  );
}
