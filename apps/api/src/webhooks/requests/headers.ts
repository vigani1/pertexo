import type { FastifyRequest } from 'fastify';

export const WEBHOOK_FRESHNESS_ALLOWANCE_SECONDS = 300;

export function headerPresent(request: FastifyRequest, name: string): boolean {
  // Webhook verification reads raw headers intentionally: unlike ordinary HTTP
  // adaptation, duplicate or comma-folded signature inputs must be rejected.
  return request.raw.rawHeaders.some(
    (value, index) => index % 2 === 0 && value.toLowerCase() === name,
  );
}

export function singleHeader(
  request: FastifyRequest,
  name: string,
): string | undefined {
  const values: string[] = [];
  const raw = request.raw.rawHeaders;
  for (let index = 0; index < raw.length; index += 2)
    if (raw[index]?.toLowerCase() === name) values.push(raw[index + 1] ?? '');
  const value = values[0];
  return values.length === 1 && value !== undefined && !value.includes(',')
    ? value
    : undefined;
}
