import { z } from 'zod';

const positionSchema = z
  .object({ time: z.iso.datetime(), id: z.uuid() })
  .strict();
const cursorSchema = z
  .object({
    asOf: z.iso.datetime(),
    leases: positionSchema.nullable(),
    deliveries: positionSchema.nullable(),
    publications: positionSchema.nullable(),
    failures: positionSchema.nullable(),
  })
  .strict();
export type StuckWorkCursor = z.output<typeof cursorSchema>;
export type StuckWorkPosition = z.output<typeof positionSchema>;

export function decodeStuckWorkCursor(
  cursor: string | undefined,
): StuckWorkCursor | undefined {
  if (cursor === undefined) return undefined;
  try {
    if (cursor.length > 4096) throw new Error('Oversized cursor');
    return cursorSchema.parse(
      JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
    );
  } catch {
    throw new TypeError('The stuck-work cursor is invalid. Restart the list.');
  }
}
export function encodeStuckWorkCursor(cursor: StuckWorkCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}
