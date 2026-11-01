import type { DeadlineWakeupScanner } from './contract.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  acquireDatabasePool,
  withPlatformTransaction,
} from '@pertexo/database/platform';
import type {
  DatabaseRuntime,
  DatabaseConfig,
} from '@pertexo/database/platform';
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
