import type { WebhookAuthentication } from '@pertexo/contracts';
import type { FastifyReply } from 'fastify';

export function webhookOriginAllowed(
  policy: WebhookAuthentication,
  origin: string,
): boolean {
  return policy.mode !== 'signed' && policy.allowedOrigins.includes(origin);
}

export function allowWebhookOrigin(reply: FastifyReply, origin: string): void {
  const prior = reply.getHeader('vary');
  let values: readonly string[] = [];
  if (typeof prior === 'string')
    values = prior.split(',').map((value) => value.trim());
  else if (Array.isArray(prior)) values = prior;
  reply
    .header('access-control-allow-origin', origin)
    .header('vary', [...new Set([...values, 'Origin'])].join(', '));
}

export function webhookPreflightHeaders(
  policy: WebhookAuthentication,
  requested: string | undefined,
): readonly string[] | undefined {
  const allowed = [
    'content-type',
    'idempotency-key',
    ...(policy.mode === 'header_secret' ? [policy.headerName] : []),
  ];
  if (requested === undefined) return [];
  if (requested.length > 1024) return undefined;
  const names = requested.split(',').map((name) => name.trim().toLowerCase());
  return names.every((name) => allowed.includes(name)) &&
    new Set(names).size === names.length
    ? names
    : undefined;
}
