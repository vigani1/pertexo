import { z } from 'zod';

import {
  LOCK_TIMEOUT_MILLIS,
  STATEMENT_TIMEOUT_MILLIS,
  timeoutMillisSchema,
} from '../../shared/transaction-timeouts.schemas.js';

/**
 * A purge pass is bounded more tightly than other maintenance: it holds the
 * workspace row, so its lock and statement waits stop sooner.
 */
const PURGE_TIMEOUT_MAX_MILLIS = Object.freeze({
  lock: 60_000,
  statement: 120_000,
});

/** How long one page of stored objects may take to erase. */
const OBJECT_TIMEOUT_MILLIS = Object.freeze({
  minimum: 1_000,
  maximum: 120_000,
  default: 30_000,
});

/** How many rows, or stored objects, one purge step removes per call. */
const PURGE_PAGE_SIZE = Object.freeze({
  minimum: 1,
  maximum: 1_000,
  default: 500,
});

const pageSizeSchema = z
  .number()
  .int()
  .min(PURGE_PAGE_SIZE.minimum)
  .max(PURGE_PAGE_SIZE.maximum)
  .default(PURGE_PAGE_SIZE.default);

export type WorkspacePurgeOptions = Readonly<z.input<typeof optionsSchema>>;

export const optionsSchema = z
  .object({
    lockTimeoutMs: timeoutMillisSchema({
      ...LOCK_TIMEOUT_MILLIS,
      maximum: PURGE_TIMEOUT_MAX_MILLIS.lock,
    }),
    objectPageSize: pageSizeSchema,
    objectTimeoutMs: timeoutMillisSchema(OBJECT_TIMEOUT_MILLIS),
    pageSize: pageSizeSchema,
    statementTimeoutMs: timeoutMillisSchema({
      ...STATEMENT_TIMEOUT_MILLIS,
      maximum: PURGE_TIMEOUT_MAX_MILLIS.statement,
    }),
  })
  .strict();
