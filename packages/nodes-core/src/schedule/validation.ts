import { boundedNodeJsonSchema } from '@pertexo/node-sdk';
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

export type CoreScheduleConfig = Readonly<
  z.output<typeof CORE_SCHEDULE_CONFIG_SCHEMA>
>;
