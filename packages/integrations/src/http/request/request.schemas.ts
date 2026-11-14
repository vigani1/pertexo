import { utf8ByteLength } from '@pertexo/workflow-model';
import { z } from 'zod';
import {
  HTTP_PAGINATION_LIMITS,
  httpPaginationSchema,
} from './pagination/pagination.schemas.js';
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
} from './multipart/multipart.schemas.js';
import { HTTP_PLACEHOLDER_NAME, httpTemplateProblem } from './placeholders.js';
import {
  credentialLikeHeader,
  httpRequestHeadersSchema,
} from './request-headers.schemas.js';
import { HTTP_HEADER_LIMITS } from '@pertexo/contracts';

const MAX_URL_BYTES = 2_048;
const MAX_REQUEST_BODY_BYTES = ARTIFACT_INPUT_MAX_BYTES;
const MAX_RESPONSE_BYTES = 10_485_760;
const MAX_INLINE_RESPONSE_BYTES = 262_144;
/** HTTP request step bounds beyond the byte sizes above. */
const HTTP_REQUEST_FIELD_LIMITS = Object.freeze({
  maxTimeoutMillis: 120_000,
  defaultTimeoutMillis: 10_000,
  maxRedirects: 5,
  defaultRedirects: 3,
  defaultResponseBytes: 1_048_576,
  defaultInlineResponseBytes: 65_536,
  responseHeaderValueCharacters: 2_048,
});
const F = HTTP_REQUEST_FIELD_LIMITS;
// A response status is final (200–599); success is 200–299.
const RESPONSE_STATUS = Object.freeze({ first: 200, last: 599 });
const SUCCESS_STATUS = Object.freeze({ first: 200, last: 299 });
// Base64 writes 4 characters for every 3 bytes, padded to a whole group.
const BASE64_GROUP = Object.freeze({ bytes: 3, characters: 4 });
const base64Characters = (bytes: number) =>
  Math.ceil((bytes * BASE64_GROUP.characters) / BASE64_GROUP.bytes) +
  BASE64_GROUP.characters;

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

export const httpRequestConfigSchema = z
  .object({
    method: z
      .enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'])
      .meta({ default: 'GET' }),
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
    headers: httpRequestHeadersSchema.meta({ default: {} }),
    timeoutMillis: z
      .number()
      .int()
      .min(1)
      .max(F.maxTimeoutMillis)
      .meta({ default: F.defaultTimeoutMillis }),
    maxRedirects: z
      .number()
      .int()
      .min(0)
      .max(F.maxRedirects)
      .meta({ default: F.defaultRedirects }),
    maxResponseBytes: z
      .number()
      .int()
      .min(1)
      .max(MAX_RESPONSE_BYTES)
      .meta({ default: F.defaultResponseBytes }),
    inlineResponseBytes: z
      .number()
      .int()
      .min(1)
      .max(MAX_INLINE_RESPONSE_BYTES)
      .meta({ default: F.defaultInlineResponseBytes }),
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
    value: z.string().max(base64Characters(MAX_REQUEST_BODY_BYTES)),
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
    value: z.string().max(base64Characters(MAX_INLINE_RESPONSE_BYTES)),
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
    status: z
      .number()
      .int()
      .min(RESPONSE_STATUS.first)
      .max(RESPONSE_STATUS.last),
    headers: z.record(
      z.string().max(HTTP_HEADER_LIMITS.nameCharacters),
      z.string().max(F.responseHeaderValueCharacters),
    ),
    body: z.discriminatedUnion('kind', [inlineBodySchema, artifactBodySchema]),
    finalOrigin: z.string().max(MAX_URL_BYTES),
    redirectCount: z.number().int().min(0).max(F.maxRedirects),
  })
  .strict()
  .readonly();

const paginatedHttpRequestOutputSchema = z
  .object({
    items: z.array(z.json()),
    pageCount: z.number().int().min(1).max(HTTP_PAGINATION_LIMITS.maxPages),
    complete: z.boolean(),
    status: z.number().int().min(SUCCESS_STATUS.first).max(SUCCESS_STATUS.last),
    headers: z.record(
      z.string().max(HTTP_HEADER_LIMITS.nameCharacters),
      z.string().max(F.responseHeaderValueCharacters),
    ),
    finalOrigin: z.string().max(MAX_URL_BYTES),
  })
  .strict()
  .readonly();
const pagedHttpRequestOutputSchema = filePageBundleSchema
  .unwrap()
  .safeExtend({
    fetchedPageCount: z
      .number()
      .int()
      .min(1)
      .max(HTTP_PAGINATION_LIMITS.maxPages),
    complete: z.boolean(),
    status: z.number().int().min(SUCCESS_STATUS.first).max(SUCCESS_STATUS.last),
    headers: z.record(
      z.string().max(HTTP_HEADER_LIMITS.nameCharacters),
      z.string().max(F.responseHeaderValueCharacters),
    ),
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
