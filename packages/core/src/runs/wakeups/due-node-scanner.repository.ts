import type { DueNodeWakeupScanner } from './contract.js';
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

export function createDueNodeWakeupScanner(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): DueNodeWakeupScanner {
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
              sql`select app.claim_due_node_run_wakeups(${limit})::integer as claimed`,
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
