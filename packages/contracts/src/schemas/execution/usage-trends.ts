import { z } from 'zod';
import { workflowRunStatisticsResponseSchema } from './runs.js';

export const usageTrendPeriodSchema = z.enum(['30d', '90d']);
export const usageTrendsQuerySchema = z
  .object({ period: usageTrendPeriodSchema.optional() })
  .strict();
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const duration = z
  .number()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
  .nullable();
const counts = workflowRunStatisticsResponseSchema.shape.window.shape.byStatus;
const elapsed = z
  .object({ measuredRuns: count, averageMs: duration, slowestMs: duration })
  .strict();
const ranked = z
  .object({
    workflowId: z.uuid(),
    workflowName: z.string().max(128).nullable(),
    runs: count,
    failures: count,
  })
  .strict();
export const usageTrendsResponseSchema = z
  .object({
    period: usageTrendPeriodSchema,
    asOf: z.iso.datetime({ precision: 6 }),
    from: z.iso.datetime({ precision: 6 }),
    before: z.iso.datetime({ precision: 6 }),
    coverageFrom: z.iso.datetime({ precision: 6 }),
    total: count,
    byStatus: counts,
    elapsed,
    days: z
      .array(
        z
          .object({
            day: z.iso.date(),
            total: count,
            byStatus: counts,
            elapsed,
          })
          .strict(),
      )
      .max(90),
    busiest: z.array(ranked).max(10),
    mostFailures: z.array(ranked).max(10),
  })
  .strict();
export type UsageTrendPeriod = z.output<typeof usageTrendPeriodSchema>;
export type UsageTrendsResponse = z.output<typeof usageTrendsResponseSchema>;
