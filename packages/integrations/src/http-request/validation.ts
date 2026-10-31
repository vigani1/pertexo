import { utf8ByteLength } from '@pertexo/workflow-model';
import { z } from 'zod';
import { httpPaginationSchema } from './pagination/validation.js';
import {
  ARTIFACT_INPUT_MAX_BYTES,
  FILE_PAGE_LIMITS,
  filePageBundleSchema,
  nodeArtifactReferenceSchema,
} from '@pertexo/node-sdk';

import {
  httpMultipartConfigSchema,
  httpMultipartFileSchema,
  httpMultipartInputKeySchema,
  httpMultipartValueSchema,
} from './multipart/validation.js';
import { isSerializableHttpHeaderValue } from '../http/header-value.js';
import { HTTP_PLACEHOLDER_NAME, httpTemplateProblem } from './placeholders.js';

const MAX_URL_BYTES = 2_048;
const MAX_REQUEST_BODY_BYTES = ARTIFACT_INPUT_MAX_BYTES;
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
  .refine(isSerializableHttpHeaderValue);
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
const blockedCredentialHeaders = new Set([
  'accept-encoding',
  'connection',
  'content-length',
  'host',
  'idempotency-key',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const credentialLikeHeader = /(?:auth|credential|secret|token|api[-_]?key)/iu;

function safeConfiguredHeader(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    !blockedConfiguredHeaders.has(normalized) &&
    !credentialLikeHeader.test(normalized)
  );
}

export function safeRequestUrl(value: string): boolean {
  try {
    const url = new URL(value);
    // Plain http reaches only networks the operator allowed; dispatch checks.
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      url.username === '' &&
      url.password === '' &&
      url.hash === '' &&
      [...url.searchParams.keys()].every(
        (name) => !credentialLikeHeader.test(name),
      )
    );
  } catch {
    return false;
  }
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
      bytes += utf8ByteLength(`${canonicalName}:${value}\r\n`);
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

export const resolvedHttpHeadersCredentialSchema = z
  .object({
    type: z.literal('http_headers'),
    headers: z
      .record(headerNameSchema, headerValueSchema)
      .superRefine((headers, context) => {
        const entries = Object.entries(headers);
        if (entries.length < 1 || entries.length > 32)
          context.addIssue({
            code: 'custom',
            message: 'credential header count is invalid',
          });
        const normalized = new Set<string>();
        let bytes = 0;
        for (const [name, value] of entries) {
          const canonicalName = name.toLowerCase();
          bytes += utf8ByteLength(`${canonicalName}:${value}\r\n`);
          if (
            normalized.has(canonicalName) ||
            blockedCredentialHeaders.has(canonicalName)
          )
            context.addIssue({
              code: 'custom',
              path: [name],
              message: 'credential header is invalid',
            });
          normalized.add(canonicalName);
        }
        if (bytes > 16_384)
          context.addIssue({
            code: 'custom',
            message: 'credential headers exceed byte limit',
          });
      })
      .transform((headers) =>
        Object.freeze(
          Object.fromEntries(
            Object.entries(headers)
              .map(([name, value]) => [name.toLowerCase(), value] as const)
              .sort(([left], [right]) => left.localeCompare(right)),
          ),
        ),
      ),
  })
  .strict();

export const httpRequestConfigSchema = z
  .object({
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']),
    url: z
      .url()
      .max(MAX_URL_BYTES)
      .refine((value) => utf8ByteLength(value) <= MAX_URL_BYTES)
      .refine(safeRequestUrl, {
        error:
          'Use an http or https address with no password, fragment or credential in its query, such as api_key. Keep credentials in a connection.',
      })
      .meta({
        title: 'URL',
        description:
          'An https address, or http inside a private network your administrator allowed. Put {name} in the path or query, or in a header value, and map a value for it on Inputs.',
      }),
    headers: httpRequestHeadersSchema,
    timeoutMillis: z.number().int().min(1).max(120_000),
    maxRedirects: z.number().int().min(0).max(5),
    maxResponseBytes: z.number().int().min(1).max(MAX_RESPONSE_BYTES),
    inlineResponseBytes: z.number().int().min(1).max(MAX_INLINE_RESPONSE_BYTES),
    multipart: httpMultipartConfigSchema.optional(),
    pagination: httpPaginationSchema.optional(),
    returnErrorResponses: z.boolean().optional().meta({
      title: 'Return error responses',
      description:
        'Pass a 3xx, 4xx or 5xx response on as the step’s output instead of failing, so a Condition can check its status.',
    }),
  })
  .strict()
  .superRefine((config, context) => {
    if (config.pagination !== undefined && config.method !== 'GET')
      context.addIssue({
        code: 'custom',
        path: ['pagination'],
        message: 'Pagination supports GET requests only',
      });
    if (
      config.pagination !== undefined &&
      (config.returnErrorResponses ?? false)
    )
      context.addIssue({
        code: 'custom',
        path: ['returnErrorResponses'],
        message: 'Turn off Return error responses when using pagination',
      });
    if (
      config.multipart !== undefined &&
      (config.method === 'GET' || config.method === 'HEAD')
    )
      context.addIssue({
        code: 'custom',
        path: ['multipart'],
        message: 'GET and HEAD cannot send a multipart body',
      });
    if (
      config.multipart !== undefined &&
      Object.keys(config.headers).some(
        (name) => name.toLowerCase() === 'content-type',
      )
    )
      context.addIssue({
        code: 'custom',
        path: ['headers'],
        message:
          'Multipart generates Content-Type; remove the configured Content-Type header',
      });
    if (config.inlineResponseBytes > config.maxResponseBytes)
      context.addIssue({
        code: 'custom',
        path: ['inlineResponseBytes'],
        message: 'inline response limit cannot exceed the response limit',
      });
    const template = httpTemplateProblem(config);
    if (template !== undefined)
      context.addIssue({ code: 'custom', path: ['url'], message: template });
  })
  .readonly();

const inlineRequestBodySchema = z
  .object({
    encoding: z.enum(['base64', 'utf8']),
    value: z.string().max(Math.ceil((MAX_REQUEST_BODY_BYTES * 4) / 3) + 4),
  })
  .strict()
  .readonly();
export const httpRequestInputSchema = z
  .object({
    body: z
      .union([
        inlineRequestBodySchema,
        httpMultipartFileSchema
          .extend({
            byteLength: z.number().int().min(0).max(FILE_PAGE_LIMITS.fileBytes),
          })
          .readonly(),
      ])
      .optional(),
  })
  .catchall(
    z.union([
      httpMultipartValueSchema,
      inlineRequestBodySchema,
      z.number(),
      z.boolean(),
    ]),
  )
  .superRefine((input, context) => {
    for (const [key, value] of Object.entries(input)) {
      if (key === 'body') continue;
      // A value for a {placeholder} in the address or a header.
      const placeholderValue =
        HTTP_PLACEHOLDER_NAME.test(key) &&
        (typeof value === 'string' ||
          typeof value === 'boolean' ||
          (typeof value === 'number' && Number.isFinite(value)));
      if (placeholderValue) continue;
      const invalidMultipartValue =
        !httpMultipartInputKeySchema.safeParse(key).success ||
        (typeof value !== 'string' &&
          (typeof value !== 'object' || !('kind' in value)));
      if (invalidMultipartValue)
        context.addIssue({
          code: 'custom',
          path: [key],
          message: 'Use a multipart part key with text or a file reference',
        });
    }
  })
  .readonly();

const inlineBodySchema = z
  .object({
    kind: z.literal('inline'),
    encoding: z.enum(['base64', 'utf8']),
    value: z.string().max(Math.ceil((MAX_INLINE_RESPONSE_BYTES * 4) / 3) + 4),
    byteLength: z.number().int().min(0).max(MAX_INLINE_RESPONSE_BYTES),
    // A JSON response, parsed, for later steps to map into.
    json: z.json().optional(),
  })
  .strict()
  .readonly();
const artifactBodySchema = nodeArtifactReferenceSchema
  .unwrap()
  .extend({
    kind: z.literal('artifact'),
    byteLength: z.number().int().min(0).max(MAX_RESPONSE_BYTES),
  })
  .strict()
  .readonly();

const singleHttpRequestOutputSchema = z
  .object({
    // Below 300 unless the step returns error responses.
    status: z.number().int().min(200).max(599),
    headers: z.record(z.string().max(128), z.string().max(2_048)),
    body: z.discriminatedUnion('kind', [inlineBodySchema, artifactBodySchema]),
    finalOrigin: z.string().max(MAX_URL_BYTES),
    redirectCount: z.number().int().min(0).max(5),
  })
  .strict()
  .readonly();

const paginatedHttpRequestOutputSchema = z
  .object({
    items: z.array(z.json()),
    pageCount: z.number().int().min(1).max(100),
    complete: z.boolean(),
    status: z.number().int().min(200).max(299),
    headers: z.record(z.string().max(128), z.string().max(2_048)),
    finalOrigin: z.string().max(MAX_URL_BYTES),
  })
  .strict()
  .readonly();
const pagedHttpRequestOutputSchema = filePageBundleSchema
  .unwrap()
  .safeExtend({
    fetchedPageCount: z.number().int().min(1).max(100),
    complete: z.boolean(),
    status: z.number().int().min(200).max(299),
    headers: z.record(z.string().max(128), z.string().max(2_048)),
    finalOrigin: z.string().max(MAX_URL_BYTES),
  })
  .readonly();
export const httpRequestOutputSchema = z.union([
  singleHttpRequestOutputSchema,
  paginatedHttpRequestOutputSchema,
  pagedHttpRequestOutputSchema,
]);

export type HttpRequestConfig = z.output<typeof httpRequestConfigSchema>;
export type HttpRequestInput = z.output<typeof httpRequestInputSchema>;
export type HttpRequestOutput = z.output<typeof httpRequestOutputSchema>;

export const HTTP_REQUEST_LIMITS = Object.freeze({
  maxInlineResponseBytes: MAX_INLINE_RESPONSE_BYTES,
  maxInlineRequestBodyBytes: MAX_REQUEST_BODY_BYTES,
  maxRequestBodyBytes: FILE_PAGE_LIMITS.fileBytes,
  maxResponseBytes: MAX_RESPONSE_BYTES,
  maxUrlBytes: MAX_URL_BYTES,
});
