import { z } from 'zod';
import { parseJsonPath } from '../values/json/path.js';
import { TRIGGER_INTERVAL_MINUTES } from './interval.js';

export const HTTP_POLL_TRIGGER = { key: 'http.poll', version: 1 } as const;

export const HTTP_POLL_CONNECTION_SLOT = 'http_headers';

export const POLL_MAX_ITEMS = 100;
export const POLL_MAX_SEEN_KEYS = 10 * POLL_MAX_ITEMS;

const pollingPath = z
  .string()
  .refine((path) => parseJsonPath(path) !== undefined);

const pollUrl = z.url({ protocol: /^https?$/u });

export const httpPollConfigSchema = z.strictObject({
  url: pollUrl.meta({
    title: 'Feed URL',
    description: 'An absolute HTTP or HTTPS URL that returns JSON.',
  }),
  intervalMinutes: z
    .number()
    .int()
    .min(TRIGGER_INTERVAL_MINUTES.minimum)
    .max(TRIGGER_INTERVAL_MINUTES.maximum)
    .meta({
      title: 'Check every (minutes)',
      default: TRIGGER_INTERVAL_MINUTES.minimum,
    }),
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
