import {
  PARALLEL_BRANCH_PORTS,
  parallelBranchPortSchema,
  parallelConfigSchema,
} from '@pertexo/workflow-model';
import { z } from 'zod';

export const CORE_PARALLEL_CONFIG_SCHEMA = parallelConfigSchema;
export const CORE_PARALLEL_INPUT_SCHEMA = z.object({}).strict();
export const CORE_PARALLEL_OUTPUT_SCHEMA = z
  .object({
    branchIds: z
      .array(parallelBranchPortSchema)
      .min(2)
      .max(PARALLEL_BRANCH_PORTS.length)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: 'Parallel output branch IDs must be unique',
      }),
  })
  .strict();
