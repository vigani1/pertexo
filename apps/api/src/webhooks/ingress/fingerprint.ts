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

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Keep the stored request identity compatible with existing replay receipts. */
export function webhookRequestFingerprint(
  input: Readonly<{
    endpointId: string;
    method: 'GET' | 'POST';
    body: Uint8Array;
    mediaType: string;
    query: string;
  }>,
): string {
  return sha256(
    input.method === 'GET'
      ? `${input.endpointId}\0GET\0${sha256(input.query)}`
      : `${input.endpointId}\0${sha256(input.body)}\0${input.mediaType}${input.query === '' ? '' : `\0${sha256(input.query)}`}`,
  );
}

export function webhookEndpointKeyHash(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}
export function webhookReplayKeyHash(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}
