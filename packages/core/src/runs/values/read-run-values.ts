import { RUN_VALUE_LIMITS, type RunValues } from '@pertexo/node-sdk';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import { RunValuesLimitError } from './run-values.errors.js';
import { readRunValueRows } from './rows.repository.js';

export async function runValuesInTransaction(
  transaction: WorkspaceTransaction,
  runId: string,
): Promise<RunValues> {
  const rows = await readRunValueRows(transaction, runId);
  if (rows.length > RUN_VALUE_LIMITS.pairs) throw new RunValuesLimitError();
  return Object.freeze(
    Object.fromEntries(rows.map(({ key, value }) => [key, value])),
  );
}
