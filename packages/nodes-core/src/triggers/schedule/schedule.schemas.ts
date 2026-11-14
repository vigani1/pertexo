import { CronExpressionParser } from 'cron-parser';
import { z } from 'zod';
import { cronHasUnsupportedOperators } from '@pertexo/workflow-model';

const CORE_SCHEDULE_MAX_INTERVAL_MINUTES = 43_200;
const CRON_EXPRESSION = Object.freeze({
  // `* * * * *`: five one-character fields and their spaces.
  minimumCharacters: 9,
  maximumCharacters: 255,
  fields: 5,
});
const SCHEDULE_NODE_ID_CHARACTERS = 128;
const SCHEDULE_TIME_ZONE_CHARACTERS = 255;
const CORE_SCHEDULE_MISFIRE_POLICY_SCHEMA = z
  .enum(['catch_up_once', 'skip'])
  .default('catch_up_once');

const strictCronExpressionSchema = z
  .string()
  .min(CRON_EXPRESSION.minimumCharacters)
  .max(CRON_EXPRESSION.maximumCharacters)
  .refine((expression) => expression === expression.trim(), {
    message: 'Cron expression must not contain surrounding whitespace',
  })
  .refine(
    (expression) => {
      const fields = expression.trim().split(/\s+/u);
      return (
        fields.length === CRON_EXPRESSION.fields &&
        expression === fields.join(' ')
      );
    },
    { message: 'Expected a strict five-field cron expression' },
  )
  .refine((expression) => !cronHasUnsupportedOperators(expression), {
    message: 'Cron expression contains an unsupported token',
  });
const canonicalIanaTimezones = new Set(Intl.supportedValuesOf('timeZone'));
const timezoneSchema = z
  .string()
  .min(1)
  .max(SCHEDULE_TIME_ZONE_CHARACTERS)
  .refine(
    (timezone) => canonicalIanaTimezones.has(timezone),
    'Expected a canonical IANA timezone',
  );

export const CORE_SCHEDULE_CONFIG_SCHEMA = z.discriminatedUnion('kind', [
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
    triggerId: z.uuid(),
    nodeId: z.string().trim().min(1).max(SCHEDULE_NODE_ID_CHARACTERS),
    scheduledAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const CORE_SCHEDULE_INPUT_SCHEMA = scheduleTriggerEnvelopeSchema;
export const CORE_SCHEDULE_OUTPUT_SCHEMA =
  scheduleTriggerEnvelopeSchema.clone();
