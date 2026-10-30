import { z } from 'zod';

export const PARALLEL_BRANCH_PORTS = Object.freeze([
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

export const parallelBranchPortSchema = z.enum(PARALLEL_BRANCH_PORTS);
export const parallelConfigSchema = z
  .object({
    branches: z
      .array(z.object({ id: parallelBranchPortSchema }).strict())
      .min(2)
      .max(PARALLEL_BRANCH_PORTS.length),
    maxConcurrency: z.number().int().min(1).max(PARALLEL_BRANCH_PORTS.length),
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

export type ParallelConfig = Readonly<z.output<typeof parallelConfigSchema>>;
