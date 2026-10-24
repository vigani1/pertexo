import { z } from 'zod';
import { MAX_SCHEDULE_PROJECTION } from './recurrence.js';
import type { TriggerRead } from './contract.js';

export const uuidSchema = z.uuid();

export const pageLimitSchema = z.number().int().positive().max(100);

export const countSchema = z.number().int().min(1).max(MAX_SCHEDULE_PROJECTION);

const instantSchema = z.iso
  .datetime({ precision: 6 })
  .refine((value) => !value.startsWith('0000-'), {
    message: 'PostgreSQL timestamps do not support year zero',
  });

export const positionSchema = z
  .object({ scheduledAt: instantSchema, id: uuidSchema })
  .strict();

export function parseTriggerRead(input: TriggerRead): TriggerRead {
  return Object.freeze({
    workspaceId: uuidSchema.parse(input.workspaceId),
    actorId: uuidSchema.parse(input.actorId),
    workflowId: uuidSchema.parse(input.workflowId),
    triggerId: uuidSchema.parse(input.triggerId),
  });
}
