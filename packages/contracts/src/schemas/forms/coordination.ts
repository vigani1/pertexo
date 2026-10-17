import { z } from 'zod';
import {
  eventCoordinationStatusSchema,
  eventCoordinationReasonSchema,
} from '@pertexo/workflow-model';
export const coordinatedEventSchema = z
  .object({
    id: z.uuid(),
    nodeId: z.string().min(1).max(128),
    source: z.enum(['webhook', 'form']),
    mode: z.enum(['deduplicate', 'debounce', 'throttle']),
    outcome: z.enum([
      'accepted',
      'skipped',
      'deduplicated',
      'debounced',
      'throttled',
      'refused',
    ]),
    status: eventCoordinationStatusSchema,
    reason: eventCoordinationReasonSchema.nullable(),
    runId: z.uuid().nullable(),
    versionNumber: z.number().int().positive(),
    receivedAt: z.iso.datetime(),
    dueAt: z.iso.datetime().nullable(),
    finishedAt: z.iso.datetime().nullable(),
  })
  .strict();
const position = z
  .object({ receivedAt: z.iso.datetime(), id: z.uuid() })
  .strict();
export const coordinatedEventHistorySchema = z
  .object({
    items: z.array(coordinatedEventSchema).max(100),
    next: position.nullable(),
  })
  .strict();
export const coordinatedEventHistoryQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    before: z.iso.datetime().exactOptional(),
    beforeId: z.uuid().exactOptional(),
  })
  .strict()
  .refine(
    (value) => (value.before === undefined) === (value.beforeId === undefined),
    'Supply both history cursor fields.',
  );
export type CoordinatedEvent = z.output<typeof coordinatedEventSchema>;
export type CoordinatedEventHistory = z.output<
  typeof coordinatedEventHistorySchema
>;
