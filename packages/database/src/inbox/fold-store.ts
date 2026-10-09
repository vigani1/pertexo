import { z } from 'zod';

import type { DatabaseConfig } from '../config.js';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../platform/pool/runtime.js';
import { withPlatformTransaction } from '../tenant-access/transactions.js';
import { checkDatabaseReadiness } from '../platform/readiness.js';

/** A workspace whose inbox changed, with its newest thread revision. */
export type WorkspaceInboxChange = Readonly<{
  workspaceId: string;
  revision: string;
}>;

export interface WorkspaceInboxFoldStore {
  /** Fails unless the database is at the expected migration. */
  checkReadiness(signal?: AbortSignal): Promise<void>;
  /** Folds up to `limit` pending failures into their workflows' threads. */
  foldPending(
    limit: number,
    signal?: AbortSignal,
  ): Promise<readonly WorkspaceInboxChange[]>;
  close(): Promise<void>;
}

const STATEMENT_TIMEOUT_MILLIS = 5_000;
const limitSchema = z.number().int().min(1).max(1_000);
const changeRowSchema = z
  .object({
    workspace_id: z.uuid(),
    revision: z.string().regex(/^[1-9][0-9]{0,18}$/u),
  })
  .strict();

/** ADR 055: the worker's fold command, run across workspaces. */
export function createWorkspaceInboxFoldStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): WorkspaceInboxFoldStore {
  const lease = acquireDatabasePool(config, runtime);
  const { pool } = lease;
  const options = (signal: AbortSignal | undefined) => ({
    ...(signal === undefined ? {} : { signal }),
    statementTimeoutMillis: STATEMENT_TIMEOUT_MILLIS,
  });
  return Object.freeze({
    checkReadiness: async (signal?: AbortSignal) => {
      signal?.throwIfAborted();
      await checkDatabaseReadiness(pool);
    },
    foldPending: (limit: number, signal?: AbortSignal) => {
      const bounded = limitSchema.parse(limit);
      return withPlatformTransaction(
        pool,
        async (client) => {
          const result = await client.query(
            'select workspace_id,revision::text from app.fold_workspace_inbox_events($1)',
            [bounded],
          );
          return Object.freeze(
            result.rows.map((value) => {
              const row = changeRowSchema.parse(value);
              return Object.freeze({
                workspaceId: row.workspace_id,
                revision: row.revision,
              });
            }),
          );
        },
        options(signal),
      );
    },
    close: () => lease.close(),
  });
}
