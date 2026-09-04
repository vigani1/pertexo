import { z } from 'zod';

export const CORE_PARALLEL_BRANCH_PORTS = Object.freeze([
  'branch-01',
  'branch-02',
  'branch-03',
  'branch-04',
  'branch-05',
  'branch-06',
  'branch-07',
  'branch-08',
  'branch-09',
  'branch-10',
  'branch-11',
  'branch-12',
  'branch-13',
  'branch-14',
  'branch-15',
  'branch-16',
] as const);

export const CORE_PARALLEL_BRANCH_PORT_SCHEMA = z.enum(
  CORE_PARALLEL_BRANCH_PORTS,
);
export const CORE_PARALLEL_CONFIG_SCHEMA = z
  .object({
    branches: z
      .array(z.object({ id: CORE_PARALLEL_BRANCH_PORT_SCHEMA }).strict())
      .min(2)
      .max(CORE_PARALLEL_BRANCH_PORTS.length),
    maxConcurrency: z
      .number()
      .int()
      .min(1)
      .max(CORE_PARALLEL_BRANCH_PORTS.length),
  })
  .strict()
  .superRefine(({ branches, maxConcurrency }, context) => {
    if (new Set(branches.map(({ id }) => id)).size !== branches.length)
      context.addIssue({
        code: 'custom',
        path: ['branches'],
        message: 'Parallel branch IDs must be unique',
      });
    if (maxConcurrency > branches.length)
      context.addIssue({
        code: 'custom',
        path: ['maxConcurrency'],
        message: 'Parallel concurrency cannot exceed branch count',
      });
  });
export const CORE_PARALLEL_INPUT_SCHEMA = z.object({}).strict();
export const CORE_PARALLEL_OUTPUT_SCHEMA = z
  .object({
    branchIds: z
      .array(CORE_PARALLEL_BRANCH_PORT_SCHEMA)
      .min(2)
      .max(CORE_PARALLEL_BRANCH_PORTS.length),
  })
  .strict();

export const CORE_PARALLEL_OUTPUT_SCHEMA_V2 = z
  .object({
    branchIds: z
      .array(CORE_PARALLEL_BRANCH_PORT_SCHEMA)
      .min(2)
      .max(CORE_PARALLEL_BRANCH_PORTS.length)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: 'Parallel output branch IDs must be unique',
      }),
  })
  .strict();

export type CoreParallelConfig = Readonly<
  z.output<typeof CORE_PARALLEL_CONFIG_SCHEMA>
>;
