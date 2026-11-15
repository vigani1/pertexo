import { z } from 'zod';

import {
  timeoutMillisSchema,
  transactionTimeoutsShape,
} from '../../shared/transaction-timeouts.schemas.js';

/** How long erasing one artifact's bytes from the store may take. */
const EXTERNAL_OPERATION_TIMEOUT_MILLIS = Object.freeze({
  minimum: 1_000,
  maximum: 300_000,
  default: 30_000,
});

/** The erasure timeout option every retention coordinator takes. */
export const externalOperationTimeoutSchema = timeoutMillisSchema(
  EXTERNAL_OPERATION_TIMEOUT_MILLIS,
);

export type RunArtifactRetentionStoreOptions = Readonly<
  z.input<typeof optionsSchema>
>;

export const optionsSchema = z
  .object({
    externalOperationTimeoutMs: externalOperationTimeoutSchema,
    ...transactionTimeoutsShape,
  })
  .strict();
