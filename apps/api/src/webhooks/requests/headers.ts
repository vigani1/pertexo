import type { FastifyRequest } from 'fastify';
import { rawHeaderValues } from '../../platform/http/raw-headers.js';

export function headerPresent(request: FastifyRequest, name: string): boolean {
  // Webhook verification reads raw headers intentionally: unlike ordinary HTTP
  // adaptation, duplicate or comma-folded signature inputs must be rejected.
  return rawHeaderValues(request.raw.rawHeaders, name).length > 0;
}

export function singleHeader(
  request: FastifyRequest,
  name: string,
): string | undefined {
  const values = rawHeaderValues(request.raw.rawHeaders, name);
  const value = values[0];
  return values.length === 1 && value !== undefined && !value.includes(',')
    ? value
    : undefined;
}
