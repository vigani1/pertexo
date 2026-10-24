import type {
  RetentionPassResult,
  RetentionDatabase,
  RetentionDatabaseOptions,
} from './contract.js';
import { optionsSchema } from './input.js';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '../../platform/query-errors.js';

import type { DatabaseConfig } from '../../config.js';
import { acquireDatabasePool } from '../../platform/pool/runtime.js';
import type { DatabaseRuntime } from '../../platform/pool/runtime.js';
import { checkDatabaseReadiness } from '../../platform/readiness.queries.js';
import { RETENTION_RULES, type RetentionRuleName } from './rules.js';
import { inRetentionTransaction } from './transactions.repository.js';

/** Advisory lock class for the rules; the rule's index is the second key. */
const RETENTION_LOCK_CLASS = 1_934_781_128;

export function createRetentionDatabase(
  config: DatabaseConfig,
  inputOptions: RetentionDatabaseOptions = {},
  runtime?: DatabaseRuntime,
): RetentionDatabase {
  const options = optionsSchema.parse(inputOptions);
  const lease = acquireDatabasePool(config, runtime, { role: 'maintenance' });
  const { pool } = lease;
  return Object.freeze({
    checkReadiness: async (signal?: AbortSignal) => {
      signal?.throwIfAborted();
      await checkDatabaseReadiness(pool);
    },
    close: () => lease.close(),
    enforce: async (signal?: AbortSignal) => {
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
