import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import { runValuesInTransaction } from './read-run-values.js';
import { insertRunValues } from './rows.repository.js';

/** A recovery run starts with the values its source run held. */
export async function copyRecoveryRunValues(
  transaction: WorkspaceTransaction,
  sourceRunId: string,
  runId: string,
): Promise<void> {
  const values = await runValuesInTransaction(transaction, sourceRunId);
  await insertRunValues(transaction, runId, values);
}
