import { z } from 'zod';

import { GovernanceError } from '../contract.js';

const cursorSchema = z
  .object({ time: z.iso.datetime(), id: z.uuid() })
  .strict();

export type AuditCursor = z.output<typeof cursorSchema>;

export function decodeAuditCursor(
  encoded: string | undefined,
): AuditCursor | undefined {
  if (encoded === undefined) return undefined;
  try {
    return cursorSchema.parse(
      JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')),
    );
  } catch {
    throw new GovernanceError(
      'invalid',
      'The audit cursor is invalid. Reload the audit log.',
    );
  }
}

export function encodeAuditCursor(cursor: AuditCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

/** The position of a row, in PostgreSQL's microseconds rather than a Date's. */
export function auditCursorOf(
  row: Readonly<{ cursorTime: string; id: string }>,
): AuditCursor {
  return { time: row.cursorTime, id: row.id };
}
