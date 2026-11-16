import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import { runValuesInTransaction } from '../values/read-run-values.js';
import {
  readWorkflowRunRow,
  type WorkflowRunReadRecord,
} from './workflow-run-records.repository.js';

/** The retained run's read record with its values. */
export async function readWorkflowRunReadRecord(
  transaction: WorkspaceTransaction,
  runId: string,
  options: Readonly<{ includeWorkflowName: boolean }>,
): Promise<WorkflowRunReadRecord | undefined> {
  const row = await readWorkflowRunRow(transaction, runId, options);
  if (row === undefined) return undefined;
  return Object.freeze({
    ...row,
    runValues: await runValuesInTransaction(transaction, runId),
  });
}
