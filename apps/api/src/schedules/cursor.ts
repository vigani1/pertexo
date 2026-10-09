import { z } from 'zod';

import {
  decodeOpaqueCursor,
  encodeOpaqueCursor,
} from '../platform/http/opaque-cursor.js';

const occurrenceCursorPayloadSchema = z
  .object({
    kind: z.literal('schedule_occurrences'),
    triggerId: z.uuid(),
    scheduledAt: z.iso.datetime({ precision: 6 }),
    id: z.uuid(),
  })
  .strict()
  .readonly();

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
