import {
  USAGE_TREND_PERIOD_DAYS,
  USAGE_TREND_RANKED_WORKFLOWS,
} from '@pertexo/workflow-model';
import { storedTimestampSchema } from '../shared/stored-timestamp.js';
import { RESOURCE_NAME_MAX_LENGTH } from '../shared/resource-name.js';
import { responseSchema } from '../shared/response-schema.js';
import { z } from 'zod';
import { workflowRunStatisticsResponseSchema } from './run-statistics.js';

const USAGE_TRENDS_BOUNDS = Object.freeze({
  workflowNameCharacters: RESOURCE_NAME_MAX_LENGTH,
  // One entry per day of the longest period.
  daysItems: USAGE_TREND_PERIOD_DAYS['90d'],
  rankedItems: USAGE_TREND_RANKED_WORKFLOWS,
});

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
    workflowName: z
      .string()
      .max(USAGE_TRENDS_BOUNDS.workflowNameCharacters)
      .nullable(),
    runs: count,
    failures: count,
  })
  .strict();
export const usageTrendsResponseSchema = responseSchema(
  z
    .object({
      period: usageTrendPeriodSchema,
      asOf: storedTimestampSchema,
      from: storedTimestampSchema,
      before: storedTimestampSchema,
      coverageFrom: storedTimestampSchema,
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
        .max(USAGE_TRENDS_BOUNDS.daysItems),
      busiest: z.array(ranked).max(USAGE_TRENDS_BOUNDS.rankedItems),
      mostFailures: z.array(ranked).max(USAGE_TRENDS_BOUNDS.rankedItems),
    })
    .strict(),
);
export type UsageTrendPeriod = z.output<typeof usageTrendPeriodSchema>;
export type UsageTrendsResponse = z.output<typeof usageTrendsResponseSchema>;
