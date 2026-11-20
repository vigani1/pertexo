import { labelledChoice } from '@pertexo/node-sdk';
import { z } from 'zod';
import { parseJsonPath } from '../values/json/path.js';
import { TRIGGER_INTERVAL_MINUTES } from './interval.js';

export const HTTP_POLL_TRIGGER = { key: 'http.poll', version: 1 } as const;

export const DATABASE_POLL_TRIGGER = {
  key: 'database.poll',
  version: 1,
} as const;
export const POSTGRES_CONNECTION_SLOT = 'postgres';

export function isPollingTriggerDefinition(
  definition: Readonly<{ key: string; version: number }>,
) {
  return [HTTP_POLL_TRIGGER, DATABASE_POLL_TRIGGER].some(
    ({ key, version }) =>
      definition.key === key && definition.version === version,
  );
}

export const HTTP_POLL_CONNECTION_SLOT = 'http_headers';

export const POLL_MAX_ITEMS = 100;
export const POLL_MAX_SEEN_KEYS = 10 * POLL_MAX_ITEMS;

const pollingPath = z
  .string()
  .refine((path) => parseJsonPath(path) !== undefined);

const pollUrl = z.url({ protocol: /^https?$/u });

const pollIntervalMinutes = z
  .number()
  .int()
  .min(TRIGGER_INTERVAL_MINUTES.minimum)
  .max(TRIGGER_INTERVAL_MINUTES.maximum)
  .meta({
    title: 'Check every (minutes)',
    default: TRIGGER_INTERVAL_MINUTES.minimum,
  });

export const httpPollConfigSchema = z.strictObject({
  url: pollUrl.meta({
    title: 'Feed URL',
    description: 'An absolute HTTP or HTTPS URL that returns JSON.',
  }),
  intervalMinutes: pollIntervalMinutes,
  itemsPath: pollingPath.meta({
    title: 'Items path',
    description: 'JSON path to the array of items.',
    default: '$',
  }),
  itemKeyPath: pollingPath.meta({
    title: 'Item key path',
    description: 'JSON path within each item to its string or number key.',
    default: '$.id',
  }),
});

export type HttpPollConfig = z.output<typeof httpPollConfigSchema>;

export const POSTGRES_IDENTIFIER_CHARACTERS = 63;
export const postgresIdentifierSchema = z
  .string()
  .min(1)
  .max(POSTGRES_IDENTIFIER_CHARACTERS)
  .regex(/^[^\0]+$/u);

export const databasePollConfigSchema = z.strictObject({
  schema: postgresIdentifierSchema.meta({ title: 'Schema', default: 'public' }),
  table: postgresIdentifierSchema.meta({ title: 'Table' }),
  orderingColumn: postgresIdentifierSchema.meta({
    title: 'Ordering column',
    description:
      'Use an increasing column. For updates, use a value that advances on every change.',
  }),
  keyColumn: postgresIdentifierSchema.meta({
    title: 'Key column',
    description: 'Use a stable, non-null column with a unique index.',
  }),
  intervalMinutes: pollIntervalMinutes,
  mode: labelledChoice({
    new: 'New rows only',
    new_or_updated: 'New and updated rows',
  }).meta({ title: 'Watch for', default: 'new' }),
});

export type DatabasePollConfig = z.output<typeof databasePollConfigSchema>;

// Existing HTTP publications have no source tag.
export const materializedPollConfigSchema = z.union([
  httpPollConfigSchema.extend({ connectionId: z.uuid().optional() }),
  databasePollConfigSchema.extend({
    source: z.literal('postgres'),
    connectionId: z.uuid(),
  }),
]);

export type MaterializedPollConfig = z.output<
  typeof materializedPollConfigSchema
>;
