import { createDatabasePool } from '../platform/postgres-telemetry.js';

import type { DatabaseConfig } from '../config.js';

export interface DueNodeWakeupScanner {
  claimDueWakeups(limit: number): Promise<number>;
  close(): Promise<void>;
}

export function createDueNodeWakeupScanner(
  config: DatabaseConfig,
): DueNodeWakeupScanner {
  const pool = createDatabasePool(config);
  return Object.freeze({
    claimDueWakeups: async (limit: number): Promise<number> => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new TypeError('Due node wakeup limit must be between 1 and 100');
      const result = await pool.query<{ claimed: number }>(
        'select app.claim_due_node_run_wakeups($1)::integer as claimed',
        [limit],
      );
      return result.rows[0]?.claimed ?? 0;
    },
    close: async (): Promise<void> => pool.end(),
  });
}
