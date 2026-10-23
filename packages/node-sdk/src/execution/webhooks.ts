export const WEBHOOK_RESPONSE_MAX_BYTES = 1_048_576;
export const WEBHOOK_RESPONSE_HEADER_NAMES = [
  'content-language',
  'retry-after',
  'x-request-id',
  'x-correlation-id',
] as const;

const RESERVED_RESPONSE_HEADERS = new Set([
  'x-content-type-options',
  'x-frame-options',
  'x-xss-protection',
  'x-download-options',
  'x-permitted-cross-domain-policies',
  'x-dns-prefetch-control',
  'x-robots-tag',
  'x-powered-by',
  'x-real-ip',
  'x-sendfile',
  'x-original-url',
  'x-original-uri',
  'x-rewrite-url',
]);
const RESERVED_RESPONSE_PREFIXES = [
  'x-forwarded',
  'x-accel',
  'x-pertexo',
  'x-envoy',
];

/** Response-control and proxy headers cannot be supplied by workflow data. */
export function isWebhookResponseHeaderAllowed(name: string): boolean {
  const lower = name.toLowerCase();
  const allowed =
    WEBHOOK_RESPONSE_HEADER_NAMES.some((value) => value === lower) ||
    (lower.length <= 64 &&
      /^x-[!#$%&'*+.^_`|~0-9a-z-]+$/u.test(lower) &&
      !RESERVED_RESPONSE_HEADERS.has(lower) &&
      !RESERVED_RESPONSE_PREFIXES.some((prefix) => lower.startsWith(prefix)));
  return allowed;
}

/** Already validated and serialized by the Respond to webhook step. */
export type NodeWebhookResponse = Readonly<{
  statusCode: number;
  contentType:
    'application/json' | 'text/plain' | 'text/csv' | 'application/xml';
  headers: Readonly<Record<string, string>>;
  body: string;
}>;
export type NodeWebhookResponseReceipt = Readonly<{
  outcome: 'responded' | 'already_responded' | 'not_waiting' | 'preview';
  statusCode: number | null;
}>;
export interface NodeWebhookResponseRuntime {
  respond(
    input: Readonly<{
      response: NodeWebhookResponse;
      signal: AbortSignal;
    }>,
  ): Promise<NodeWebhookResponseReceipt>;
}
