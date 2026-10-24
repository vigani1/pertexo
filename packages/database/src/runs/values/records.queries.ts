import { and, eq, sql } from 'drizzle-orm';
import { RUN_VALUE_LIMITS, type RunValues } from '@pertexo/node-sdk';
import type { WorkspaceTransaction } from '../../tenant-access/transactions.js';
import { workflowRunValues } from '../../schema/runs/values.js';
import { workflowRuns } from '../../schema/runs/execution.js';
import { expiredRunSql } from '../data-policy.js';
import { generatePersistedId } from '../../platform/persisted-id.js';
import { RunValuesLimitError } from './records.js';

export async function runValuesInTransaction(
  transaction: WorkspaceTransaction,
  runId: string,
): Promise<RunValues> {
  const rows = await transaction.db
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
  if (rows.length > RUN_VALUE_LIMITS.pairs) throw new RunValuesLimitError();
  return Object.freeze(
    Object.fromEntries(rows.map(({ key, value }) => [key, value])),
  );
}

export async function copyRecoveryRunValues(
  transaction: WorkspaceTransaction,
  sourceRunId: string,
  runId: string,
): Promise<void> {
  const values = await runValuesInTransaction(transaction, sourceRunId);
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
