import { z } from 'zod';

import { transactionTimeoutsShape } from '../../shared/transaction-timeouts.schemas.js';

/** How many rows one retention rule deletes per pass. */
const RETENTION_PAGE_SIZE = Object.freeze({
  minimum: 1,
  maximum: 1_000,
  default: 100,
});

export type RetentionStoreOptions = Readonly<z.input<typeof optionsSchema>>;

export const optionsSchema = z
  .object({
    ...transactionTimeoutsShape,
    pageSize: z
      .number()
      .int()
      .min(RETENTION_PAGE_SIZE.minimum)
      .max(RETENTION_PAGE_SIZE.maximum)
      .default(RETENTION_PAGE_SIZE.default),
  })
  .strict();
