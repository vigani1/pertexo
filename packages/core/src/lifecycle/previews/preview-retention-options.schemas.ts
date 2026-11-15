import { z } from 'zod';

import { transactionTimeoutsShape } from '../../shared/transaction-timeouts.schemas.js';
import { externalOperationTimeoutSchema } from '../artifacts/artifact-retention-options.schemas.js';

/** How long a deleting artifact stays untouched, so in-flight uploads time out first. */
const ARTIFACT_QUIESCENCE_SECONDS = Object.freeze({
  minimum: 1,
  maximum: 120,
  default: 60,
});

export type PreviewRetentionCoordinatorOptions = Readonly<
  z.input<typeof optionsSchema>
>;

export const optionsSchema = z
  .object({
    artifactQuiescenceSeconds: z
      .number()
      .int()
      .min(ARTIFACT_QUIESCENCE_SECONDS.minimum)
      .max(ARTIFACT_QUIESCENCE_SECONDS.maximum)
      .default(ARTIFACT_QUIESCENCE_SECONDS.default),
    externalOperationTimeoutMs: externalOperationTimeoutSchema,
    ...transactionTimeoutsShape,
  })
  .strict();
