import { responseSchema } from '../shared/response-schema.js';
import { z } from 'zod';
import { workflowNameSchema } from '../workflows/authoring.js';

/** Fixed statistics windows; every one lies well inside run retention. */
export const workflowRunStatisticsWindowSchema = z.enum([
  '1h',
  '6h',
  '24h',
  '7d',
]);
const workflowRunStatisticsBreakdownSchema = z.enum(['workflow']);
/** Workflows returned by a per-workflow breakdown, busiest first. */
export const WORKFLOW_RUN_STATISTICS_WORKFLOW_LIMIT = 50;
export const workflowRunStatisticsQuerySchema = z
  .object({
    window: workflowRunStatisticsWindowSchema.optional(),
    breakdown: workflowRunStatisticsBreakdownSchema.optional(),
  })
  .strict();
const workflowRunCountSchema = z.number().int().nonnegative();
const workflowRunStatisticsTimestampSchema = z.iso.datetime({ precision: 6 });
/** Exact PostgreSQL bigint bytes; never rounded through a JSON number. */
const capacityBytesSchema = z.string().regex(/^(?:0|[1-9][0-9]{0,18})$/u);
const capacityCountSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);
/** ADR057: operational capacity is separate from retained run activity. */
export const usageCapacityResponseSchema = responseSchema(
  z
    .object({
      asOf: workflowRunStatisticsTimestampSchema,
      execution: z
        .object({
          activeRuns: capacityCountSchema,
          reservedActiveSlots: capacityCountSchema,
          activeCapacityConsumed: capacityCountSchema,
          queuedRuns: capacityCountSchema,
          policy: z
            .object({
              state: z.enum([
                'active',
                'suspended',
                'not_yet_effective',
                'expired',
                'unavailable',
              ]),
              version: z.number().int().positive().nullable(),
              activeRunLimit: z.number().int().min(1).max(10_000).nullable(),
              queuedRunLimit: z.number().int().min(1).max(100_000).nullable(),
            })
            .strict(),
        })
        .strict(),
      artifacts: z
        .object({
          chargedBytes: capacityBytesSchema,
          byteLimit: capacityBytesSchema,
          chargedCount: capacityCountSchema,
          artifactCountLimit: capacityCountSchema,
          source: z.enum(['stored', 'default']),
        })
        .strict(),
    })
    .strict(),
);
export type UsageCapacityResponse = z.infer<typeof usageCapacityResponseSchema>;
/** One exact count per run status. */
const workflowRunStatusCountsSchema = z
  .object({
    queued: workflowRunCountSchema,
    running: workflowRunCountSchema,
    waiting: workflowRunCountSchema,
    succeeded: workflowRunCountSchema,
    failed: workflowRunCountSchema,
    canceled: workflowRunCountSchema,
    timed_out: workflowRunCountSchema,
    outcome_unknown: workflowRunCountSchema,
  })
  .strict();
/** Runs that are not finished yet, whenever they were created. */
const workflowRunCurrentCountsSchema = workflowRunStatusCountsSchema
  .pick({ queued: true, running: true, waiting: true })
  .strict();
const workflowRunWorkflowStatisticsSchema = z
  .object({
    workflowId: z.uuid(),
    workflowName: workflowNameSchema.nullable().optional(),
    total: workflowRunCountSchema,
    byStatus: workflowRunStatusCountsSchema,
  })
  .strict();
export const workflowRunStatisticsResponseSchema = responseSchema(
  z
    .object({
      asOf: workflowRunStatisticsTimestampSchema,
      current: workflowRunCurrentCountsSchema,
      window: z
        .object({
          duration: workflowRunStatisticsWindowSchema,
          createdAtFrom: workflowRunStatisticsTimestampSchema,
          createdAtBefore: workflowRunStatisticsTimestampSchema,
          total: workflowRunCountSchema,
          skippedTriggerEvents: workflowRunCountSchema.optional(),
          coordinatedTriggerEvents: workflowRunCountSchema.optional(),
          byStatus: workflowRunStatusCountsSchema,
        })
        .strict(),
      workflows: z
        .object({
          items: z
            .array(workflowRunWorkflowStatisticsSchema)
            .max(WORKFLOW_RUN_STATISTICS_WORKFLOW_LIMIT),
          truncated: z.boolean(),
        })
        .strict()
        .nullable(),
    })
    .strict(),
);
export type WorkflowRunStatisticsWindow = z.output<
  typeof workflowRunStatisticsWindowSchema
>;
export type WorkflowRunStatisticsQuery = z.output<
  typeof workflowRunStatisticsQuerySchema
>;
export type WorkflowRunStatisticsResponse = z.output<
  typeof workflowRunStatisticsResponseSchema
>;
