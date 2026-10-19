import type { WebhookAuthentication } from '@pertexo/contracts';
import type { FastifyRequest } from 'fastify';

// Credentials, signature inputs and what proxies add on the way stay out of
// the run, and so out of run history.
const WITHHELD_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-pertexo-signature',
  'x-pertexo-timestamp',
  'forwarded',
  'via',
  'x-real-ip',
  'connection',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Form or query fields; a repeated name keeps every value, in order. */
export function searchFields(
  search: string,
): Record<string, string | string[]> {
  const fields = new Map<string, string[]>();
  for (const [name, value] of new URLSearchParams(search))
    fields.set(name, [...(fields.get(name) ?? []), value]);
  return Object.fromEntries(
    [...fields].map(([name, values]) => [
      name,
      values.length === 1 ? (values[0] ?? '') : values,
    ]),
  );
}

/** The query string exactly as sent, without the `?`. */
export function rawWebhookQuery(request: FastifyRequest): string {
  const index = request.url.indexOf('?');
  return index === -1 ? '' : request.url.slice(index + 1);
}

export function webhookHeaders(
  request: FastifyRequest,
  policy: WebhookAuthentication,
): Record<string, string> {
  const secretHeader =
    policy.mode === 'header_secret' ? policy.headerName : undefined;
  const headers: [string, string][] = [];
  for (const [name, value] of Object.entries(request.headers)) {
    if (
      value === undefined ||
      name === secretHeader ||
      WITHHELD_HEADERS.has(name) ||
      name.startsWith('x-forwarded-')
    )
      continue;
    headers.push([name, Array.isArray(value) ? value.join(', ') : value]);
  }
  return Object.fromEntries(headers);
}
