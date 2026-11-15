import { z } from 'zod';
import { eventCoordinationPolicySchema } from './event-coordination/event-coordination.schemas.js';

/** How long a webhook caller may wait for a Respond to webhook step. */
export const WEBHOOK_RESPONSE_WAIT_SECONDS = Object.freeze({
  default: 10,
  maximum: 30,
});

// Endpoint keys and signing secrets belong to materialized trigger state.
export const CORE_WEBHOOK_CONFIG_SCHEMA = z
  .object({
    coordination: eventCoordinationPolicySchema.exactOptional(),
    runInput: z
      .enum(['body', 'request'])
      .optional()
      .describe(
        'What the run receives: the data sent (body, or query for GET), or the whole request with its method, query and headers.',
      ),
    responseMode: z
      .enum(['immediate', 'workflow'])
      .optional()
      .describe(
        'Respond immediately with 202, or wait briefly for a Respond to webhook step.',
      ),
    responseWaitSeconds: z
      .number()
      .int()
      .min(1)
      .max(WEBHOOK_RESPONSE_WAIT_SECONDS.maximum)
      .optional()
      .describe(
        `Seconds to wait, ${String(WEBHOOK_RESPONSE_WAIT_SECONDS.default)} by default. On timeout the caller gets 202 and the run continues.`,
      ),
  })
  .strict();
