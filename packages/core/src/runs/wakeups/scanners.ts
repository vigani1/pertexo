import { sql, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  acquireDatabasePool,
  withPlatformTransaction,
  type DatabaseConfig,
  type DatabaseRuntime,
} from '@pertexo/database/platform';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { parseClaimedWakeups } from './scan-result.js';

export type WakeupScanner = ReturnType<typeof createWakeupScanner>;

/** Claims due wakeups across workspaces: no member behind it, so it stays off the helper. */
function createWakeupScanner(
  claim: (limit: number) => SQL,
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
) {
  const lease = acquireDatabasePool(config, runtime, { role: 'maintenance' });
  return Object.freeze({
    claimDueWakeups: (limit: number, signal?: AbortSignal): Promise<number> =>
      withPlatformTransaction(
        lease.pool,
        async (client) => {
          const result = await drizzle(client)
            .execute<{ claimed: number }>(claim(limit))
            .catch(rethrowQueryFailure);
          return parseClaimedWakeups(result.rows, limit);
        },
        signal === undefined ? {} : { signal },
      ),
    close: () => lease.close(),
  });
}

export function createDeadlineWakeupScanner(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): WakeupScanner {
  return createWakeupScanner(
    (limit) =>
      sql`select app.claim_due_workflow_run_deadlines(${limit})::integer as claimed`,
    config,
    runtime,
  );
}

export function createDueNodeWakeupScanner(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): WakeupScanner {
  return createWakeupScanner(
    (limit) =>
      sql`select app.claim_due_node_run_wakeups(${limit})::integer as claimed`,
    config,
    runtime,
  );
}
