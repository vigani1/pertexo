import { responseSchema } from '../shared/response-schema.js';
import { z } from 'zod';
import {
  eventCoordinationStatusSchema,
  eventCoordinationReasonSchema,
  WORKFLOW_GRAPH_CONTRACT_LIMITS,
} from '@pertexo/workflow-model';

const COORDINATION_BOUNDS = Object.freeze({
  nodeIdCharacters: WORKFLOW_GRAPH_CONTRACT_LIMITS.identifierLength,
  coordinatedEventHistoryPageItems: 100,
  coordinatedEventHistoryPageDefault: 25,
});
export const coordinatedEventSchema = z
  .object({
    id: z.uuid(),
    nodeId: z.string().min(1).max(COORDINATION_BOUNDS.nodeIdCharacters),
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
export const coordinatedEventHistorySchema = responseSchema(
  z
    .object({
      items: z
        .array(coordinatedEventSchema)
        .max(COORDINATION_BOUNDS.coordinatedEventHistoryPageItems),
      next: position.nullable(),
    })
    .strict(),
);
export const coordinatedEventHistoryQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(COORDINATION_BOUNDS.coordinatedEventHistoryPageItems)
      .default(COORDINATION_BOUNDS.coordinatedEventHistoryPageDefault),
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
