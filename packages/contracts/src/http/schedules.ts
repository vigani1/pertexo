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

/** ADR 048: what one recorded occurrence did, in the scanner's own terms. */
export const scheduleOccurrenceOutcomeSchema = z.enum(['accepted', 'skipped']);
export const scheduleOccurrenceCursorSchema = z.string().min(1).max(512);
export const scheduleOccurrencePageLimitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(100);
export const scheduleOccurrenceListQuerySchema = z
  .object({
    limit: scheduleOccurrencePageLimitSchema.optional(),
    after: scheduleOccurrenceCursorSchema.optional(),
  })
  .strict();
export const scheduleOccurrenceSchema = z
  .object({
    id: z.uuid(),
    scheduledAt: z.iso.datetime(),
    recordedAt: z.iso.datetime(),
    outcome: scheduleOccurrenceOutcomeSchema,
    runId: z.uuid().nullable(),
  })
  .strict();
export const scheduleOccurrenceListResponseSchema = z
  .object({
    items: z.array(scheduleOccurrenceSchema).max(100),
    nextCursor: scheduleOccurrenceCursorSchema.nullable(),
  })
  .strict();

/** ADR 048: upcoming fire times are bounded; three unless asked otherwise. */
export const SCHEDULE_FIRE_TIME_DEFAULT_COUNT = 3;
export const scheduleFireTimeCountSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(10);
export const scheduleNextRunsQuerySchema = z
  .object({ count: scheduleFireTimeCountSchema.optional() })
  .strict();
export const scheduleFireTimesResponseSchema = z
  .object({
    observedAt: z.iso.datetime(),
    items: z
      .array(z.object({ scheduledAt: z.iso.datetime() }).strict())
      .max(10),
  })
  .strict();

const scheduleStepMisfirePolicySchema = z
  .enum(['catch_up_once', 'skip'])
  .optional();
/**
 * The Schedule step's own setup shape (`core.schedule` v2+). Structure is
 * checked here; the scheduler's parser checks the rule in its timezone.
 */
export const scheduleStepConfigSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('cron'),
      expression: z
        .string()
        .min(9)
        .max(255)
        .regex(/^[^\sH?#L]+(?: [^\sH?#L]+){4}$/u),
      timezone: z.string().min(1).max(255),
      misfirePolicy: scheduleStepMisfirePolicySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('interval'),
      intervalMinutes: z.number().int().min(1).max(43_200),
      misfirePolicy: scheduleStepMisfirePolicySchema,
    })
    .strict(),
]);
export const schedulePreviewRequestSchema = z
  .object({
    config: scheduleStepConfigSchema,
    count: z.number().int().min(1).max(10).optional(),
  })
  .strict();

export type ScheduleTriggerHealthResponse = z.output<
  typeof scheduleTriggerHealthSchema
>;
export type ScheduleManagementCommandResponse = z.output<
  typeof scheduleManagementCommandResponseSchema
>;
export type ScheduleOccurrenceResponse = z.output<
  typeof scheduleOccurrenceSchema
>;
export type ScheduleOccurrenceListResponse = z.output<
  typeof scheduleOccurrenceListResponseSchema
>;
export type ScheduleFireTimesResponse = z.output<
  typeof scheduleFireTimesResponseSchema
>;
export type ScheduleStepConfig = z.input<typeof scheduleStepConfigSchema>;
