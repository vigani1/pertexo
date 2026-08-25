import { z } from 'zod';

export const scheduleTriggerStatusSchema = z.enum([
  'desired',
  'configuration_required',
  'pending',
  'active',
  'degraded',
  'disabled',
  'error',
]);
export const scheduleTriggerHealthStatusSchema = z.enum([
  'healthy',
  'degraded',
  'unhealthy',
  'disabled',
]);
export const scheduleRecurrenceSummarySchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('cron'),
      expression: z.string().min(1).max(256),
      timezone: z.string().min(1).max(128),
    })
    .strict(),
  z
    .object({
      kind: z.literal('interval'),
      intervalMinutes: z.number().int().min(1).max(43_200),
    })
    .strict(),
]);
export const scheduleTriggerHealthSchema = z
  .object({
    id: z.uuid(),
    workflowId: z.uuid(),
    workflowVersionId: z.uuid(),
    nodeId: z.string().min(1).max(256),
    kind: z.literal('schedule'),
    status: scheduleTriggerStatusSchema,
    healthStatus: scheduleTriggerHealthStatusSchema,
    lastErrorCode: z.string().max(128).nullable(),
    reconciledAt: z.iso.datetime().nullable(),
    recurrence: scheduleRecurrenceSummarySchema,
    misfirePolicy: z.enum(['catch_up_once', 'skip']),
    nextFireAt: z.iso.datetime(),
    lastFireAt: z.iso.datetime().nullable(),
  })
  .strict();
export const scheduleTriggerListResponseSchema = z
  .object({ items: z.array(scheduleTriggerHealthSchema).max(1_000) })
  .strict();
export const scheduleManagementCommandRequestSchema = z.object({}).strict();
export const scheduleManagementCommandResponseSchema = z
  .object({ trigger: scheduleTriggerHealthSchema, replayed: z.boolean() })
  .strict();

export type ScheduleTriggerHealthResponse = z.output<
  typeof scheduleTriggerHealthSchema
>;
export type ScheduleManagementCommandResponse = z.output<
  typeof scheduleManagementCommandResponseSchema
>;
