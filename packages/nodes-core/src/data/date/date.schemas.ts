import { z } from 'zod';
import { labelledChoice } from '@pertexo/node-sdk';
import { ianaTimeZoneSchema } from '@pertexo/workflow-model';

const timeZoneSchema = ianaTimeZoneSchema.meta({ default: 'UTC' });

export const CORE_DATE_CONFIG_SCHEMA = z
  .discriminatedUnion('operation', [
    z
      .object({
        operation: z.literal('to_iso').meta({ title: 'ISO timestamp (UTC)' }),
      })
      .strict(),
    z
      .object({
        operation: z
          .literal('to_epoch_millis')
          .meta({ title: 'Epoch milliseconds' }),
      })
      .strict(),
    z
      .object({
        operation: z.literal('format').meta({ title: 'Format timestamp' }),
        format: labelledChoice({
          date_only: 'Date only (YYYY-MM-DD)',
          date_time: 'Date and time (YYYY-MM-DD HH:mm:ss)',
          iso: 'ISO timestamp with offset',
        }).meta({ title: 'Format', default: 'date_only' }),
        timeZone: timeZoneSchema,
      })
      .strict(),
    z
      .object({
        operation: z
          .literal('convert_timezone')
          .meta({ title: 'Convert time zone' }),
        timeZone: timeZoneSchema,
      })
      .strict(),
    z
      .object({
        operation: z
          .literal('add_duration')
          .meta({ title: 'Add or subtract duration' }),
        unit: labelledChoice({
          minutes: 'Minutes',
          hours: 'Hours',
          days: 'Days (24 hours)',
          weeks: 'Weeks (168 hours)',
          months: 'Calendar months (UTC)',
        }).meta({
          title: 'Duration unit',
          description:
            'Days and weeks are elapsed UTC time. Months clamp to the last day in the target UTC month.',
          default: 'days',
        }),
      })
      .strict(),
  ])
  .meta({
    title: 'Date operation',
    description:
      'Use a date like 2026-10-19, a time with its offset like 2026-10-19T09:30:00+02:00, or epoch milliseconds.',
    default: { operation: 'to_iso' },
  });
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
