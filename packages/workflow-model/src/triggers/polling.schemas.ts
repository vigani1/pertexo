import { z } from 'zod';
import { parseJsonPath } from '../values/json/path.js';
import { TRIGGER_INTERVAL_MINUTES } from './interval.js';

export const HTTP_POLL_TRIGGER = { key: 'http.poll', version: 1 } as const;

const pollingPath = z
  .string()
  .refine((path) => parseJsonPath(path) !== undefined);

export const HTTP_POLL_CONFIG_SCHEMA = z.strictObject({
  url: z.url({ protocol: /^https?$/u }),
  intervalMinutes: z
    .number()
    .int()
    .min(TRIGGER_INTERVAL_MINUTES.minimum)
    .max(TRIGGER_INTERVAL_MINUTES.maximum),
  itemsPath: pollingPath,
  itemKeyPath: pollingPath,
});

export type HttpPollConfig = z.output<typeof HTTP_POLL_CONFIG_SCHEMA>;
