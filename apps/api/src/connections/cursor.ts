import { connectionStatusSchema } from '@pertexo/contracts';
import { z } from 'zod';

import {
  decodeOpaqueCursor,
  encodeOpaqueCursor,
  opaqueCursor,
} from '../platform/http/opaque-cursor.js';

const connectionCursorPayloadSchema = opaqueCursor('connections', {
  status: connectionStatusSchema,
  createdAt: z.iso
    .datetime({ precision: 6 })
    .refine((value) => !value.startsWith('0000-'), {
      message: 'PostgreSQL timestamps do not support year zero',
    }),
  id: z.uuid(),
}).readonly();

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
  return encodeOpaqueCursor(connectionCursorPayloadSchema, {
    kind: 'connections',
    status: cursor.status,
    createdAt: cursor.createdAt,
    id: cursor.id,
  });
}

export function decodeConnectionCursor(value: string): Readonly<{
  status: z.output<typeof connectionStatusSchema>;
  createdAt: string;
  id: string;
}> {
  const payload = decodeOpaqueCursor(connectionCursorPayloadSchema, value);
  if (payload === undefined) throw new InvalidConnectionCursorError();
  return Object.freeze({
    status: payload.status,
    createdAt: payload.createdAt,
    id: payload.id,
  });
}
