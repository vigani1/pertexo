import {
  MINIMUM_PARALLEL_BRANCHES,
  PARALLEL_BRANCH_PORTS,
  parallelBranchPortSchema,
  parallelConfigSchema,
} from '@pertexo/workflow-model';
import { z } from 'zod';

// The fewest branches, all at once.
const DEFAULT_BRANCHES = PARALLEL_BRANCH_PORTS.slice(
  0,
  MINIMUM_PARALLEL_BRANCHES,
);
export const CORE_PARALLEL_CONFIG_SCHEMA = parallelConfigSchema.meta({
  default: {
    branches: DEFAULT_BRANCHES.map((id) => ({ id })),
    maxConcurrency: DEFAULT_BRANCHES.length,
  },
});
export const CORE_PARALLEL_INPUT_SCHEMA = z.object({}).strict();
export const CORE_PARALLEL_OUTPUT_SCHEMA = z
  .object({
    branchIds: z
      .array(parallelBranchPortSchema)
      .min(MINIMUM_PARALLEL_BRANCHES)
      .max(PARALLEL_BRANCH_PORTS.length)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: 'Parallel output branch IDs must be unique',
      }),
  })
  .strict();
