import { boundedNodeJsonSchema } from '@pertexo/node-sdk';
import { CronExpressionParser } from 'cron-parser';
import { z } from 'zod';

export const CORE_SCHEDULE_MAX_INTERVAL_MINUTES = 43_200;
export const CORE_SCHEDULE_MISFIRE_POLICY_SCHEMA = z
  .enum(['catch_up_once', 'skip'])
  .default('catch_up_once');

const cronExpressionSchema = z
  .string()
  .min(9)
  .max(255)
  .regex(
    /^[0-9*/?,-]+ [0-9*/?,-]+ [0-9*/?,-]+ [0-9*/?,-]+ [0-9*/?,-]+$/u,
    'Expected a strict five-field cron expression',
  );

const strictCronExpressionSchema = z
  .string()
  .min(9)
  .max(255)
  .refine((expression) => expression === expression.trim(), {
    message: 'Cron expression must not contain surrounding whitespace',
  })
  .refine((expression) => expression.split(' ').length === 5, {
    message: 'Expected a strict five-field cron expression',
  })
  .refine((expression) => !/[H?#L]/u.test(expression), {
    message: 'Cron expression contains an unsupported token',
  });
const canonicalIanaTimezones = new Set(Intl.supportedValuesOf('timeZone'));
const timezoneSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (timezone) => canonicalIanaTimezones.has(timezone),
    'Expected a canonical IANA timezone',
  );

export const CORE_SCHEDULE_CONFIG_SCHEMA = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('cron'),
      expression: cronExpressionSchema,
      timezone: timezoneSchema,
      misfirePolicy: CORE_SCHEDULE_MISFIRE_POLICY_SCHEMA,
    })
    .strict(),
  z
    .object({
      kind: z.literal('interval'),
      intervalMinutes: z
        .number()
        .int()
        .min(1)
        .max(CORE_SCHEDULE_MAX_INTERVAL_MINUTES),
      misfirePolicy: CORE_SCHEDULE_MISFIRE_POLICY_SCHEMA,
    })
    .strict(),
]);
export const CORE_SCHEDULE_INPUT_SCHEMA = boundedNodeJsonSchema;
export const CORE_SCHEDULE_OUTPUT_SCHEMA = boundedNodeJsonSchema;

export const CORE_SCHEDULE_CONFIG_SCHEMA_V2 = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('cron'),
      expression: strictCronExpressionSchema,
      timezone: timezoneSchema.refine(
        (timezone) => !timezone.startsWith('Etc/GMT'),
        'Fixed-offset timezone aliases are unsupported',
      ),
      misfirePolicy: CORE_SCHEDULE_MISFIRE_POLICY_SCHEMA,
    })
    .strict()
    .superRefine(({ expression, timezone }, context) => {
      try {
        CronExpressionParser.parse(`0 ${expression}`, {
          currentDate: new Date(0),
          strict: true,
          tz: timezone,
        });
      } catch {
        context.addIssue({
          code: 'custom',
          path: ['expression'],
          message: 'Invalid strict cron expression',
        });
      }
    }),
  z
    .object({
      kind: z.literal('interval'),
      intervalMinutes: z
        .number()
        .int()
        .min(1)
        .max(CORE_SCHEDULE_MAX_INTERVAL_MINUTES),
      misfirePolicy: CORE_SCHEDULE_MISFIRE_POLICY_SCHEMA,
    })
    .strict(),
]);

const scheduleTriggerEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    triggerId: z.uuid(),
    nodeId: z.string().trim().min(1).max(128),
    scheduledAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const CORE_SCHEDULE_INPUT_SCHEMA_V2 = scheduleTriggerEnvelopeSchema;
export const CORE_SCHEDULE_OUTPUT_SCHEMA_V2 =
  scheduleTriggerEnvelopeSchema.clone();

export type CoreScheduleConfig = Readonly<
  z.output<typeof CORE_SCHEDULE_CONFIG_SCHEMA>
>;
