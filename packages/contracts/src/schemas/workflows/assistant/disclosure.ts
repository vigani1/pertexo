import { z } from 'zod';

export const assistantUnavailableSchema = z.strictObject({
  kind: z.enum(['not_configured', 'connection_unavailable']),
});

export const assistantReadyDisclosureSchema = z.strictObject({
  kind: z.literal('ready'),
  connectionName: z.string(),
  host: z.string(),
  model: z.string(),
  confirmation: z.string(),
});
