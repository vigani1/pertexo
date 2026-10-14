import { boundedNodeJsonSchema } from '@pertexo/node-sdk';
import { z } from 'zod';

export const CORE_WAIT_MAX_DURATION_SECONDS = 2_592_000;

export const CORE_WAIT_CONFIG_SCHEMA = z
  .object({
    durationSeconds: z
      .number()
      .int()
      .min(1)
      .max(CORE_WAIT_MAX_DURATION_SECONDS),
  })
  .strict();
export const CORE_WAIT_INPUT_SCHEMA = boundedNodeJsonSchema;
export const CORE_WAIT_OUTPUT_SCHEMA = boundedNodeJsonSchema;

export type CoreWaitConfig = Readonly<z.output<typeof CORE_WAIT_CONFIG_SCHEMA>>;
