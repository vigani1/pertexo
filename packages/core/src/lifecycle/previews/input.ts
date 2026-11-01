import { z } from 'zod';

export type PreviewRetentionCoordinatorOptions = Readonly<
  z.input<typeof optionsSchema>
>;

export const optionsSchema = z
  .object({
    artifactQuiescenceSeconds: z.number().int().min(1).max(120).default(60),
    externalOperationTimeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(300_000)
      .default(30_000),
    lockTimeoutMs: z.number().int().min(100).max(300_000).default(10_000),
    statementTimeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(300_000)
      .default(30_000),
  })
  .strict();
