import { z } from 'zod';

export const CORE_CONDITION_CONFIG_SCHEMA = z.object({}).strict();
export const CORE_CONDITION_INPUT_SCHEMA = z
  .object({ condition: z.boolean() })
  .strict();
export const CORE_CONDITION_OUTPUT_SCHEMA = z
  .object({ selectedPort: z.enum(['true', 'false']) })
  .strict();
