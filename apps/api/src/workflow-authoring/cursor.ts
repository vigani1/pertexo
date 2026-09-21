import { z } from 'zod';

const workflowCursorPayloadSchema = z
  .object({
    kind: z.literal('workflow'),
    createdAt: z.iso.datetime(),
    id: z.uuid(),
  })
  .strict()
  .readonly();

const workflowUpdatedCursorPayloadSchema = z
  .object({
    kind: z.literal('workflow_updated'),
    updatedAt: z.iso.datetime(),
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
  workflowUpdatedCursorPayloadSchema,
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
  cursor: Readonly<{ positionAt: string; id: string }>,
  order: 'created_asc' | 'updated_desc' = 'created_asc',
): string {
  return order === 'updated_desc'
    ? encodeCursor({
        kind: 'workflow_updated',
        updatedAt: cursor.positionAt,
        id: cursor.id,
      })
    : encodeCursor({
        kind: 'workflow',
        createdAt: cursor.positionAt,
        id: cursor.id,
      });
}

export function decodeWorkflowCursor(
  value: string,
  order: 'created_asc' | 'updated_desc' = 'created_asc',
): Readonly<{ positionAt: string; id: string }> {
  const payload = decodeCursor(value);
  if (order === 'updated_desc') {
    if (payload.kind !== 'workflow_updated')
      throw new InvalidWorkflowCursorError();
    return Object.freeze({
      positionAt: payload.updatedAt,
      id: payload.id,
    });
  }
  if (payload.kind !== 'workflow') throw new InvalidWorkflowCursorError();
  return Object.freeze({
    positionAt: payload.createdAt,
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
