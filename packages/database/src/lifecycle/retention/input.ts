import { z } from 'zod';

export const optionsSchema = z
  .object({
    lockTimeoutMs: z.number().int().min(100).max(300_000).default(10_000),
    pageSize: z.number().int().min(1).max(1_000).default(100),
    statementTimeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(300_000)
      .default(30_000),
  })
  .strict();
