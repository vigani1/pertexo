import { z } from 'zod';

const workflowCursorPayloadSchema = z
  .object({
    kind: z.literal('workflow'),
    createdAt: z.iso.datetime(),
    id: z.uuid(),
  })
  .strict()
  .readonly();

const versionCursorPayloadSchema = z
  .object({
    kind: z.literal('versions'),
    beforeVersionNumber: z.number().int().positive(),
  })
  .strict()
  .readonly();

const cursorPayloadSchema = z.discriminatedUnion('kind', [
  workflowCursorPayloadSchema,
  versionCursorPayloadSchema,
]);

export class InvalidWorkflowCursorError extends TypeError {
  public override readonly name = 'InvalidWorkflowCursorError';
  public constructor() {
    super('workflow cursor is invalid');
  }
}

function encodeCursor(payload: z.input<typeof cursorPayloadSchema>): string {
  return Buffer.from(
    JSON.stringify(cursorPayloadSchema.parse(payload)),
    'utf8',
  ).toString('base64url');
}

function decodeCursor(value: string): z.output<typeof cursorPayloadSchema> {
  try {
    return cursorPayloadSchema.parse(
      JSON.parse(Buffer.from(value, 'base64url').toString('utf8')),
    );
  } catch {
    throw new InvalidWorkflowCursorError();
  }
}

export function encodeWorkflowCursor(
  cursor: Readonly<{ createdAt: Date; id: string }>,
): string {
  return encodeCursor({
    kind: 'workflow',
    createdAt: cursor.createdAt.toISOString(),
    id: cursor.id,
  });
}

export function decodeWorkflowCursor(
  value: string,
): Readonly<{ createdAt: Date; id: string }> {
  const payload = decodeCursor(value);
  if (payload.kind !== 'workflow') throw new InvalidWorkflowCursorError();
  return Object.freeze({
    createdAt: new Date(payload.createdAt),
    id: payload.id,
  });
}

export function encodeVersionCursor(versionNumber: number): string {
  return encodeCursor({ kind: 'versions', beforeVersionNumber: versionNumber });
}

export function decodeVersionCursor(value: string): number {
  const payload = decodeCursor(value);
  if (payload.kind !== 'versions') throw new InvalidWorkflowCursorError();
  return payload.beforeVersionNumber;
}
