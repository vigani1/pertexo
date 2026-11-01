import { z } from 'zod';

export type WorkspacePurgeOptions = Readonly<z.input<typeof optionsSchema>>;

export const optionsSchema = z
  .object({
    lockTimeoutMs: z.number().int().min(100).max(60_000).default(10_000),
    objectPageSize: z.number().int().min(1).max(1_000).default(500),
    objectTimeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
    pageSize: z.number().int().min(1).max(1_000).default(500),
    statementTimeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(120_000)
      .default(30_000),
  })
  .strict();
