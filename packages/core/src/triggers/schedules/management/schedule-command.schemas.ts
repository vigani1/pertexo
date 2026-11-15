import { z } from 'zod';

import { WORKFLOW_GRAPH_CONTRACT_LIMITS } from '@pertexo/workflow-model';

/** What a stored schedule row can hold: its columns' widths and interval check. */
const STORED_SCHEDULE = Object.freeze({
  errorCodeCharacters: 128,
  cronExpressionCharacters: 256,
  timezoneCharacters: 128,
  intervalMinutes: 43_200,
});

export const scheduleTriggerSchema = z
  .object({
    id: z.uuid(),
    workflowId: z.uuid(),
    workflowVersionId: z.uuid(),
    nodeId: z
      .string()
      .min(1)
      .max(WORKFLOW_GRAPH_CONTRACT_LIMITS.identifierLength),
    kind: z.literal('schedule'),
    status: z.enum([
      'desired',
      'configuration_required',
      'pending',
      'active',
      'degraded',
      'disabled',
      'error',
    ]),
    healthStatus: z.enum(['healthy', 'degraded', 'unhealthy', 'disabled']),
    lastErrorCode: z
      .string()
      .max(STORED_SCHEDULE.errorCodeCharacters)
      .nullable(),
    reconciledAt: z.date().nullable(),
    recurrence: z
      .discriminatedUnion('kind', [
        z.object({
          kind: z.literal('cron'),
          expression: z
            .string()
            .min(1)
            .max(STORED_SCHEDULE.cronExpressionCharacters),
          timezone: z.string().min(1).max(STORED_SCHEDULE.timezoneCharacters),
        }),
        z.object({
          kind: z.literal('interval'),
          intervalMinutes: z
            .number()
            .int()
            .min(1)
            .max(STORED_SCHEDULE.intervalMinutes),
        }),
      ])
      .nullable(),
    misfirePolicy: z.enum(['catch_up_once', 'skip']),
    nextFireAt: z.date(),
    lastFireAt: z.date().nullable(),
  })
  .strict();
