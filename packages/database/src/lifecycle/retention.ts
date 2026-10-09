import { z } from 'zod';

import type { DatabaseConfig } from '../config.js';
import { acquireDatabasePool } from '../platform/database-runtime.js';
import type { DatabaseRuntime } from '../platform/database-runtime.js';
import { checkDatabaseReadiness } from '../platform/readiness.js';
import { RETENTION_RULES, type RetentionRuleName } from './retention-rules.js';
import { inRetentionTransaction } from './retention-transaction.js';
import {
  reapTransientData,
  type TransientDataReapResult,
} from './transient-data-retention.js';

export type { TransientDataReapResult } from './transient-data-retention.js';
export type { RetentionRuleName } from './retention-rules.js';

/** Advisory lock class for the rules; the rule's index is the second key. */
const RETENTION_LOCK_CLASS = 1_934_781_128;

export type RetentionPassResult = Readonly<{
  /** Rows each rule removed or cleared. */
  removed: Readonly<Record<RetentionRuleName, number>>;
  /** Some rule filled its page, so more rows are due now. */
  more: boolean;
}>;

export interface RetentionDatabase {
  checkReadiness(signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
  /** Runs every rule once, one page each. */
  enforce(signal?: AbortSignal): Promise<RetentionPassResult>;
  reapTransientData(signal?: AbortSignal): Promise<TransientDataReapResult>;
}

const optionsSchema = z
  .object({
    lockTimeoutMs: z.number().int().min(100).max(300_000).default(10_000),
    pageSize: z.number().int().min(1).max(1_000).default(100),
    statementTimeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(300_000)
      .default(30_000),
  })
  .strict();

export type RetentionDatabaseOptions = z.input<typeof optionsSchema>;

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
            const lock = await client.query<{ locked: boolean }>(
              'select pg_try_advisory_xact_lock($1, $2) locked',
              [RETENTION_LOCK_CLASS, index],
            );
            if (lock.rows[0]?.locked !== true) return 0;
            return (
              (await client.query(rule.statement, [options.pageSize]))
                .rowCount ?? 0
            );
          },
        );
      return Object.freeze({
        removed: Object.freeze(removed as RetentionPassResult['removed']),
        more: Object.values(removed).some((count) => count >= options.pageSize),
      });
    },
    reapTransientData: (signal?: AbortSignal) =>
      reapTransientData(pool, options, signal),
  });
}
