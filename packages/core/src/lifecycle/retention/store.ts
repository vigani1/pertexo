import type { RetentionPassResult } from './contract.js';
import { optionsSchema, type RetentionStoreOptions } from './input.js';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  rethrowQueryFailure,
  checkDatabaseReadiness,
} from '@pertexo/database/primitives';

import type {
  DatabaseConfig,
  DatabaseRuntime,
} from '@pertexo/database/platform';
import { acquireDatabasePool } from '@pertexo/database/platform';
import { RETENTION_RULES, type RetentionRuleName } from './rules.js';
import { inRetentionTransaction } from './transaction.js';

/** Advisory lock class for the rules; the rule's index is the second key. */
const RETENTION_LOCK_CLASS = 1_934_781_128;

export type RetentionStore = ReturnType<typeof createRetentionStore>;

/**
 * Runs the retention rules. No member is acting, so this stays off
 * `withWorkspaceAccess`: rules cross workspaces on the maintenance role.
 */
export function createRetentionStore(
  config: DatabaseConfig,
  inputOptions: RetentionStoreOptions = {},
  runtime?: DatabaseRuntime,
) {
  const options = optionsSchema.parse(inputOptions);
  const lease = acquireDatabasePool(config, runtime, { role: 'maintenance' });
  const { pool } = lease;
  return Object.freeze({
    checkReadiness: async (signal?: AbortSignal) => {
      signal?.throwIfAborted();
      await checkDatabaseReadiness(pool);
    },
    close: () => lease.close(),
    /** Runs every rule once, one page each. */
    enforce: async (signal?: AbortSignal): Promise<RetentionPassResult> => {
      const removed: Partial<Record<RetentionRuleName, number>> = {};
      // One transaction per rule keeps each page's locks short. A rule
      // another worker is running is skipped this pass.
      for (const [index, rule] of RETENTION_RULES.entries())
        removed[rule.name] = await inRetentionTransaction(
          pool,
          options,
          signal,
          async (client) => {
            const lock = await drizzle(client)
              .execute<{ locked: boolean }>(
                sql`select pg_try_advisory_xact_lock(${RETENTION_LOCK_CLASS}::integer,${index}::integer) locked`,
              )
              .catch(rethrowQueryFailure);
            if (!(lock.rows[0]?.locked ?? false)) return 0;
            return rule.run(client, options.pageSize);
          },
        );
      return Object.freeze({
        removed: Object.freeze(removed as RetentionPassResult['removed']),
        more: Object.values(removed).some((count) => count >= options.pageSize),
      });
    },
  });
}
