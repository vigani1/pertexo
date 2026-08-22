import { z } from 'zod';

const MAX_URL_BYTES = 2_048;
const MAX_REQUEST_BODY_BYTES = 1_048_576;
const MAX_RESPONSE_BYTES = 10_485_760;
const MAX_INLINE_RESPONSE_BYTES = 262_144;
const MAX_HEADER_BYTES = 32_768;

const headerNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u);
const headerValueSchema = z
  .string()
  .min(1)
  .max(8_192)
  .refine((value) => !/[\r\n\0]/u.test(value));
const blockedConfiguredHeaders = new Set([
  'accept-encoding',
  'authorization',
  'connection',
  'content-length',
  'cookie',
  'host',
  'idempotency-key',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const credentialLikeHeader = /(?:auth|credential|secret|token|api[-_]?key)/iu;

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function safeConfiguredHeader(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    !blockedConfiguredHeaders.has(normalized) &&
    !credentialLikeHeader.test(normalized)
  );
}

export const httpRequestHeadersSchema = z
  .record(headerNameSchema, headerValueSchema)
  .superRefine((headers, context) => {
    const names = Object.keys(headers);
    if (names.length > 64)
      context.addIssue({ code: 'custom', message: 'too many headers' });
    const normalized = new Set<string>();
    let bytes = 0;
    for (const [name, value] of Object.entries(headers)) {
      const canonicalName = name.toLowerCase();
      bytes += utf8Bytes(`${canonicalName}:${value}\r\n`);
      if (normalized.has(canonicalName))
        context.addIssue({
          code: 'custom',
          path: [name],
          message: 'header names must be case-insensitively unique',
        });
      if (!safeConfiguredHeader(canonicalName))
        context.addIssue({
          code: 'custom',
          path: [name],
          message:
            'credential-bearing and transport headers are not configurable',
        });
      normalized.add(canonicalName);
    }
    if (bytes > MAX_HEADER_BYTES)
      context.addIssue({
        code: 'custom',
        message: 'headers exceed byte limit',
      });
  });

export const httpRequestConfigSchema = z
  .object({
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']),
    url: z
      .url()
      .max(MAX_URL_BYTES)
      .refine((value) => utf8Bytes(value) <= MAX_URL_BYTES)
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === 'https:' &&
          url.username === '' &&
          url.password === '' &&
          url.hash === '' &&
          [...url.searchParams.keys()].every(
            (name) => !credentialLikeHeader.test(name),
          )
        );
      }),
    headers: httpRequestHeadersSchema,
    timeoutMillis: z.number().int().min(1).max(120_000),
    maxRedirects: z.number().int().min(0).max(5),
    maxResponseBytes: z.number().int().min(1).max(MAX_RESPONSE_BYTES),
    inlineResponseBytes: z.number().int().min(1).max(MAX_INLINE_RESPONSE_BYTES),
  })
  .strict()
  .superRefine((config, context) => {
    if (config.inlineResponseBytes > config.maxResponseBytes)
      context.addIssue({
        code: 'custom',
        path: ['inlineResponseBytes'],
        message: 'inline response limit cannot exceed the response limit',
      });
  })
  .readonly();

export const httpRequestInputSchema = z
  .object({
    body: z
      .object({
        encoding: z.enum(['base64', 'utf8']),
        value: z.string().max(Math.ceil((MAX_REQUEST_BODY_BYTES * 4) / 3) + 4),
      })
      .strict()
      .readonly()
      .optional(),
  })
  .strict()
  .readonly();

const inlineBodySchema = z
  .object({
    kind: z.literal('inline'),
    encoding: z.enum(['base64', 'utf8']),
    value: z.string().max(Math.ceil((MAX_INLINE_RESPONSE_BYTES * 4) / 3) + 4),
    byteLength: z.number().int().min(0).max(MAX_INLINE_RESPONSE_BYTES),
  })
  .strict()
  .readonly();
const artifactBodySchema = z
  .object({
    kind: z.literal('artifact'),
    artifactId: z.uuid(),
    byteLength: z.number().int().min(0).max(MAX_RESPONSE_BYTES),
    mediaType: z.string().min(3).max(255),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict()
  .readonly();

export const httpRequestOutputSchema = z
  .object({
    status: z.number().int().min(200).max(299),
    headers: z.record(z.string().max(128), z.string().max(2_048)),
    body: z.discriminatedUnion('kind', [inlineBodySchema, artifactBodySchema]),
    finalOrigin: z.string().max(MAX_URL_BYTES),
    redirectCount: z.number().int().min(0).max(5),
  })
  .strict()
  .readonly();

export type HttpRequestConfig = z.output<typeof httpRequestConfigSchema>;
export type HttpRequestInput = z.output<typeof httpRequestInputSchema>;
export type HttpRequestOutput = z.output<typeof httpRequestOutputSchema>;

export const HTTP_REQUEST_LIMITS = Object.freeze({
  maxInlineResponseBytes: MAX_INLINE_RESPONSE_BYTES,
  maxRequestBodyBytes: MAX_REQUEST_BODY_BYTES,
  maxResponseBytes: MAX_RESPONSE_BYTES,
  maxUrlBytes: MAX_URL_BYTES,
});
