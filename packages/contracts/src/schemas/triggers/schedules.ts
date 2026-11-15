import { CRON_EXPRESSION_MAX_CHARACTERS } from '@pertexo/workflow-model';
import { NODE_FAILURE_FIELD_LIMITS } from '@pertexo/node-sdk';
import { TIME_ZONE_NAME_CHARACTERS } from '@pertexo/workflow-model';
import { responseSchema } from '../shared/response-schema.js';
import { z } from 'zod';

const SCHEDULES_BOUNDS = Object.freeze({
  expressionCharacters: CRON_EXPRESSION_MAX_CHARACTERS,
  timezoneCharacters: TIME_ZONE_NAME_CHARACTERS,
  intervalMinutesMaximum: 43200,
  nodeIdCharacters: 256,
  lastErrorCodeCharacters: NODE_FAILURE_FIELD_LIMITS.safeErrorCodeCharacters,
  scheduleTriggerListPageItems: 1000,
  scheduleOccurrenceCursorCharacters: 512,
  scheduleOccurrencePageLimitMaximum: 100,
  scheduleOccurrenceListPageItems: 100,
  scheduleFireTimeCountMaximum: 10,
  scheduleFireTimesPageItems: 10,
  expressionMinimumCharacters: 9,
  previewExpressionCharacters: 255,
  previewTimezoneCharacters: 255,
  countMaximum: 10,
});

const scheduleTriggerStatusSchema = z.enum([
  'desired',
  'configuration_required',
  'pending',
  'active',
  'degraded',
  'disabled',
  'error',
]);
const scheduleTriggerHealthStatusSchema = z.enum([
  'healthy',
  'degraded',
  'unhealthy',
  'disabled',
]);
const scheduleRecurrenceSummarySchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('cron'),
      expression: z.string().min(1).max(SCHEDULES_BOUNDS.expressionCharacters),
      timezone: z.string().min(1).max(SCHEDULES_BOUNDS.timezoneCharacters),
    })
    .strict(),
  z
    .object({
      kind: z.literal('interval'),
      intervalMinutes: z
        .number()
        .int()
        .min(1)
        .max(SCHEDULES_BOUNDS.intervalMinutesMaximum),
    })
    .strict(),
]);
export const scheduleTriggerHealthSchema = z
  .object({
    id: z.uuid(),
    workflowId: z.uuid(),
    workflowVersionId: z.uuid(),
    nodeId: z.string().min(1).max(SCHEDULES_BOUNDS.nodeIdCharacters),
    kind: z.literal('schedule'),
    status: scheduleTriggerStatusSchema,
    healthStatus: scheduleTriggerHealthStatusSchema,
    lastErrorCode: z
      .string()
      .max(SCHEDULES_BOUNDS.lastErrorCodeCharacters)
      .nullable(),
    reconciledAt: z.iso.datetime().nullable(),
    recurrence: scheduleRecurrenceSummarySchema.nullable(),
    misfirePolicy: z.enum(['catch_up_once', 'skip']),
    nextFireAt: z.iso.datetime(),
    lastFireAt: z.iso.datetime().nullable(),
  })
  .strict();
export const scheduleTriggerListResponseSchema = responseSchema(
  z
    .object({
      items: z
        .array(scheduleTriggerHealthSchema)
        .max(SCHEDULES_BOUNDS.scheduleTriggerListPageItems),
    })
    .strict(),
);
export const scheduleManagementCommandRequestSchema = z.object({}).strict();
export const scheduleManagementCommandResponseSchema = responseSchema(
  z
    .object({ trigger: scheduleTriggerHealthSchema, replayed: z.boolean() })
    .strict(),
);

/**
 * ADR 048: what one recorded occurrence did, in the scanner's own terms. ADR 056
 * adds `paused`: recorded without a run while the workflow's triggers are paused.
 */
const scheduleOccurrenceOutcomeSchema = z.enum([
  'accepted',
  'skipped',
  'paused',
]);
const scheduleOccurrenceCursorSchema = z
  .string()
  .min(1)
  .max(SCHEDULES_BOUNDS.scheduleOccurrenceCursorCharacters);
const scheduleOccurrencePageLimitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(SCHEDULES_BOUNDS.scheduleOccurrencePageLimitMaximum);
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
    skipReason: z.literal('concurrency_limit').optional(),
  })
  .strict();
export const scheduleOccurrenceListResponseSchema = responseSchema(
  z
    .object({
      items: z
        .array(scheduleOccurrenceSchema)
        .max(SCHEDULES_BOUNDS.scheduleOccurrenceListPageItems),
      nextCursor: scheduleOccurrenceCursorSchema.nullable(),
    })
    .strict(),
);

/** ADR 048: upcoming fire times are bounded; three unless asked otherwise. */
export const SCHEDULE_FIRE_TIME_DEFAULT_COUNT = 3;
const scheduleFireTimeCountSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(SCHEDULES_BOUNDS.scheduleFireTimeCountMaximum);
export const scheduleNextRunsQuerySchema = z
  .object({ count: scheduleFireTimeCountSchema.optional() })
  .strict();
export const scheduleFireTimesResponseSchema = responseSchema(
  z
    .object({
      observedAt: z.iso.datetime(),
      items: z
        .array(z.object({ scheduledAt: z.iso.datetime() }).strict())
        .max(SCHEDULES_BOUNDS.scheduleFireTimesPageItems),
    })
    .strict(),
);

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
        .min(SCHEDULES_BOUNDS.expressionMinimumCharacters)
        .max(SCHEDULES_BOUNDS.previewExpressionCharacters)
        .regex(/^[^\sH?#L]+(?: [^\sH?#L]+){4}$/u),
      timezone: z
        .string()
        .min(1)
        .max(SCHEDULES_BOUNDS.previewTimezoneCharacters),
      misfirePolicy: scheduleStepMisfirePolicySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('interval'),
      intervalMinutes: z
        .number()
        .int()
        .min(1)
        .max(SCHEDULES_BOUNDS.intervalMinutesMaximum),
      misfirePolicy: scheduleStepMisfirePolicySchema,
    })
    .strict(),
]);
export const schedulePreviewRequestSchema = z
  .object({
    config: scheduleStepConfigSchema,
    count: z
      .number()
      .int()
      .min(1)
      .max(SCHEDULES_BOUNDS.countMaximum)
      .optional(),
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
