import type { acquireDatabasePool } from '@pertexo/database/platform';
import { scannerCloseFailure } from './scan-failures.js';

/** Closes both scanner pools, reporting every close that failed. */
export async function closeScheduleScannerLeases(
  claimLease: ReturnType<typeof acquireDatabasePool>,
  acceptanceLease: ReturnType<typeof acquireDatabasePool>,
): Promise<void> {
  const settled = await Promise.allSettled([
    claimLease.close(),
    acceptanceLease.close(),
  ]);
  const failures: unknown[] = [];
  for (const result of settled)
    if (result.status === 'rejected') failures.push(result.reason);
  const failure = scannerCloseFailure(failures);
  if (failure !== undefined) throw failure;
}
