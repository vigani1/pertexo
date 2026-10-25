import { z } from 'zod';

import {
  decodeOpaqueCursor,
  encodeOpaqueCursor,
  opaqueCursor,
} from '../platform/http/opaque-cursor.js';

const occurrenceCursorPayloadSchema = opaqueCursor('schedule_occurrences', {
  triggerId: z.uuid(),
  scheduledAt: z.iso
    .datetime({ precision: 6 })
    .refine((value) => !value.startsWith('0000-'), {
      message: 'PostgreSQL timestamps do not support year zero',
    }),
  id: z.uuid(),
}).readonly();

type ScheduleOccurrencePosition = Readonly<{ scheduledAt: string; id: string }>;

export class InvalidScheduleOccurrenceCursorError extends TypeError {
  public override readonly name = 'InvalidScheduleOccurrenceCursorError';

  public constructor() {
    super('schedule occurrence cursor is invalid');
  }
}

/** An opaque occurrence-history position that only continues one trigger. */
export function encodeScheduleOccurrenceCursor(
  triggerId: string,
  position: ScheduleOccurrencePosition,
): string {
  return encodeOpaqueCursor(occurrenceCursorPayloadSchema, {
    kind: 'schedule_occurrences',
    triggerId,
    scheduledAt: position.scheduledAt,
    id: position.id,
  });
}

export function decodeScheduleOccurrenceCursor(
  value: string,
  triggerId: string,
): ScheduleOccurrencePosition {
  const payload = decodeOpaqueCursor(occurrenceCursorPayloadSchema, value);
  if (payload?.triggerId !== triggerId)
    throw new InvalidScheduleOccurrenceCursorError();
  return Object.freeze({ scheduledAt: payload.scheduledAt, id: payload.id });
}
