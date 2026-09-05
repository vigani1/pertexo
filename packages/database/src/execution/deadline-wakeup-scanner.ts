import { acquireDatabasePool } from '../platform/database-runtime.js';
import type { DatabaseRuntime } from '../platform/database-runtime.js';

import type { DatabaseConfig } from '../config.js';

export interface DeadlineWakeupScanner {
  claimDueWakeups(limit: number): Promise<number>;
  close(): Promise<void>;
}

export function createDeadlineWakeupScanner(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): DeadlineWakeupScanner {
  const lease = acquireDatabasePool(config, runtime);
  const { pool } = lease;
  return Object.freeze({
    claimDueWakeups: async (limit: number): Promise<number> => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new TypeError('Deadline wakeup limit must be between 1 and 100');
      const result = await pool.query<{ claimed: number }>(
        'select app.claim_due_workflow_run_deadlines($1)::integer as claimed',
        [limit],
      );
      return result.rows[0]?.claimed ?? 0;
    },
    close: () => lease.close(),
  });
}
