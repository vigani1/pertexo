import { eventCoordinationPolicySchema } from '@pertexo/workflow-model';
import { boundedNodeJsonSchema } from '@pertexo/node-sdk';
import { z } from 'zod';

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
      .max(30)
      .optional()
      .describe(
        'Seconds to wait, 10 by default. On timeout the caller gets 202 and the run continues.',
      ),
  })
  .strict();
export const CORE_WEBHOOK_INPUT_SCHEMA = boundedNodeJsonSchema;
export const CORE_WEBHOOK_OUTPUT_SCHEMA = boundedNodeJsonSchema;
