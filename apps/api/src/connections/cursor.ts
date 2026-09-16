import { connectionStatusSchema } from '@pertexo/contracts/connections';
import { z } from 'zod';

const connectionCursorPayloadSchema = z
  .object({
    kind: z.literal('connections'),
    status: connectionStatusSchema,
    createdAt: z.iso.datetime({ precision: 6 }),
    id: z.uuid(),
  })
  .strict()
  .readonly();

export class InvalidConnectionCursorError extends TypeError {
  public override readonly name = 'InvalidConnectionCursorError';

  public constructor() {
    super('connection cursor is invalid');
  }
}

export function encodeConnectionCursor(
  cursor: Readonly<{
    status: z.output<typeof connectionStatusSchema>;
    createdAt: string;
    id: string;
  }>,
): string {
  return Buffer.from(
    JSON.stringify(
      connectionCursorPayloadSchema.parse({
        kind: 'connections',
        status: cursor.status,
        createdAt: cursor.createdAt,
        id: cursor.id,
      }),
    ),
    'utf8',
  ).toString('base64url');
}

export function decodeConnectionCursor(value: string): Readonly<{
  status: z.output<typeof connectionStatusSchema>;
  createdAt: string;
  id: string;
}> {
  try {
    const payload = connectionCursorPayloadSchema.parse(
      JSON.parse(Buffer.from(value, 'base64url').toString('utf8')),
    );
    return Object.freeze({
      status: payload.status,
      createdAt: payload.createdAt,
      id: payload.id,
    });
  } catch {
    throw new InvalidConnectionCursorError();
  }
}
