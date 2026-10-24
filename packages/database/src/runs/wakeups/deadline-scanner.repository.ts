import type { DeadlineWakeupScanner } from './contract.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { isIntegerInRange } from '../../platform/persisted-primitives.js';
import { acquireDatabasePool } from '../../platform/pool/runtime.js';
import type { DatabaseRuntime } from '../../platform/pool/runtime.js';

import type { DatabaseConfig } from '../../config.js';
import { withPlatformTransaction } from '../../tenant-access/transactions.js';
import { parseClaimedWakeups } from './scan-result.js';

export function createDeadlineWakeupScanner(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): DeadlineWakeupScanner {
  const lease = acquireDatabasePool(config, runtime);
  const { pool } = lease;
  return Object.freeze({
    claimDueWakeups: async (
      limit: number,
      signal?: AbortSignal,
    ): Promise<number> => {
      const invalidLimit = !isIntegerInRange(limit, 1, 100);
      if (invalidLimit)
        throw new TypeError('Deadline wakeup limit must be between 1 and 100');
      return withPlatformTransaction(
        pool,
        async (client) => {
          const result = await drizzle(client)
            .execute<{ claimed: number }>(
              sql`select app.claim_due_workflow_run_deadlines(${limit})::integer as claimed`,
            )
            .catch(rethrowQueryFailure);
          return parseClaimedWakeups(result.rows, limit);
        },
        signal === undefined ? {} : { signal },
      );
    },
    close: () => lease.close(),
  });
}
