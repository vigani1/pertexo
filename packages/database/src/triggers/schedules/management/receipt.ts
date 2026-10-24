import { z } from 'zod';

export const scheduleTriggerSchema = z
  .object({
    id: z.uuid(),
    workflowId: z.uuid(),
    workflowVersionId: z.uuid(),
    nodeId: z.string().min(1).max(256),
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
    lastErrorCode: z.string().max(128).nullable(),
    reconciledAt: z.date().nullable(),
    recurrence: z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('cron'),
        expression: z.string().min(1).max(256),
        timezone: z.string().min(1).max(128),
      }),
      z.object({
        kind: z.literal('interval'),
        intervalMinutes: z.number().int().min(1).max(43_200),
      }),
    ]),
    misfirePolicy: z.enum(['catch_up_once', 'skip']),
    nextFireAt: z.date(),
    lastFireAt: z.date().nullable(),
  })
  .strict();
