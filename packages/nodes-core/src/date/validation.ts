import { z } from 'zod';
export const CORE_DATE_CONFIG_SCHEMA = z
  .object({
    operation: z.enum(['to_iso', 'to_epoch_millis']).meta({
      title: 'Convert to',
      description:
        'ISO output is UTC. Epoch input/output uses integer milliseconds, never seconds.',
    }),
  })
  .strict();
export const CORE_DATE_INPUT_SCHEMA = z
  .object({ value: z.union([z.string().max(64), z.number()]) })
  .strict();
export const CORE_DATE_OUTPUT_SCHEMA = z
  .object({ value: z.union([z.string().max(64), z.number().int()]) })
  .strict();
export type CoreDateConfig = z.output<typeof CORE_DATE_CONFIG_SCHEMA>;
export type CoreDateInput = z.output<typeof CORE_DATE_INPUT_SCHEMA>;
