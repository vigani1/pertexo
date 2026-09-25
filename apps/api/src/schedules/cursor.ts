import { z } from 'zod';

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
  const payload = occurrenceCursorPayloadSchema.parse({
    kind: 'schedule_occurrences',
    triggerId,
    scheduledAt: position.scheduledAt,
    id: position.id,
  });
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeScheduleOccurrenceCursor(
  value: string,
  triggerId: string,
): ScheduleOccurrencePosition {
  const payload = occurrenceCursorPayloadSchema.safeParse(
    parseCursorJson(value),
  );
  if (!payload.success || payload.data.triggerId !== triggerId)
    throw new InvalidScheduleOccurrenceCursorError();
  return Object.freeze({
    scheduledAt: payload.data.scheduledAt,
    id: payload.data.id,
  });
}

function parseCursorJson(value: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
}
