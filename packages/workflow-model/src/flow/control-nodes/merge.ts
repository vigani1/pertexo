import { z } from 'zod';

const mergeJoinPolicySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }).strict(),
  z.object({ kind: z.literal('any') }).strict(),
  z
    .object({
      kind: z.literal('count'),
      count: z.number().int().min(1).max(16),
    })
    .strict(),
]);

export const mergeConfigSchema = z
  .object({
    parallelNodeId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u),
    policy: mergeJoinPolicySchema,
  })
  .strict();

export type MergeConfig = Readonly<z.output<typeof mergeConfigSchema>>;
