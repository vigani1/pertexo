import { z } from 'zod';
import { PARALLEL_BRANCH_PORTS } from './parallel.js';

const MERGE_PARALLEL_NODE_ID_LENGTH = 128;

const mergeJoinPolicySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }).strict(),
  z.object({ kind: z.literal('any') }).strict(),
  z
    .object({
      kind: z.literal('count'),
      // A merge waits for at most every branch of its parallel step.
      count: z.number().int().min(1).max(PARALLEL_BRANCH_PORTS.length),
    })
    .strict(),
]);

export const mergeConfigSchema = z
  .object({
    parallelNodeId: z
      .string()
      .min(1)
      .max(MERGE_PARALLEL_NODE_ID_LENGTH)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u),
    policy: mergeJoinPolicySchema,
  })
  .strict();

export type MergeConfig = Readonly<z.output<typeof mergeConfigSchema>>;
