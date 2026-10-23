import { headerPresent, singleHeader } from '../requests/headers.js';

import { createHash } from 'node:crypto';
import { idempotencyKeySchema } from '@pertexo/contracts';

import type { FastifyRequest } from 'fastify';

export function optionalIdempotencyKey(
  request: FastifyRequest,
): string | undefined | null {
  if (!headerPresent(request, 'idempotency-key')) return undefined;
  const value = singleHeader(request, 'idempotency-key');
  return value !== undefined && idempotencyKeySchema.safeParse(value).success
    ? value
    : null;
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
