import { z } from 'zod';
const timeZoneSchema = z
  .string()
  .min(1)
  .max(128)
  .superRefine((zone, context) => {
    try {
      if (!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)*$/u.test(zone))
        throw new RangeError();
      new Intl.DateTimeFormat('en-US', { timeZone: zone });
    } catch {
      context.addIssue({
        code: 'custom',
        message:
          'Use an IANA timezone such as Europe/Paris, America/New_York or UTC',
      });
    }
  })
  .meta({
    title: 'Time zone',
    description:
      'IANA name, such as Europe/Paris or America/New_York. UTC is explicit; the host timezone is never used.',
  });
export const CORE_DATE_CONFIG_SCHEMA = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('to_iso') }).strict(),
  z.object({ operation: z.literal('to_epoch_millis') }).strict(),
  z
    .object({
      operation: z.literal('format'),
      format: z
        .enum(['date_only', 'date_time', 'iso'])
        .meta({ title: 'Format' }),
      timeZone: timeZoneSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('convert_timezone'),
      timeZone: timeZoneSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('add_duration'),
      unit: z.enum(['minutes', 'hours', 'days', 'weeks', 'months']).meta({
        title: 'Duration unit',
        description:
          'Days and weeks are elapsed UTC time. Months clamp to the last day in the target UTC month.',
      }),
    })
    .strict(),
]);
export const CORE_DATE_INPUT_SCHEMA = z
  .object({
    value: z.union([z.string().max(64), z.number()]),
    amount: z.number().int().optional().meta({
      description:
        'Signed integer for Add duration; negative subtracts. Other operations ignore amount.',
    }),
  })
  .strict();
export const CORE_DATE_OUTPUT_SCHEMA = z
  .object({ value: z.union([z.string().max(64), z.number().int()]) })
  .strict();
export type CoreDateConfig = z.output<typeof CORE_DATE_CONFIG_SCHEMA>;
export type CoreDateInput = z.output<typeof CORE_DATE_INPUT_SCHEMA>;
