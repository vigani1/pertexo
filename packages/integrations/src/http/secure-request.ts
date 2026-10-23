import { utf8ByteLength } from '@pertexo/workflow-model';
import { FILE_PAGE_LIMITS } from '@pertexo/node-sdk';
import type { NodeVerifiedByteSource } from '@pertexo/node-sdk/server';
import { z } from 'zod';
import { isSerializableHttpHeaderValue } from './header-value.js';
import {
  SECURE_HTTP_ERROR_CODE,
  failure,
  inspectSecureHttpError,
} from './secure-error.js';
import type { SecureHttpRequest } from './secure.js';
import { safeInstanceOf } from './unknown-error.js';

const MAX_REQUEST_BODY_BYTES = 1_048_576;
const MAX_RESPONSE_BYTES = 10_485_760;
const MAX_HEADER_BYTES = 32_768;
const MAX_HEADER_COUNT = 64;
const MAX_HEADER_VALUE_LENGTH = 8_192;
const MAX_SENSITIVE_VALUE_COUNT = 64;
const MAX_SENSITIVE_VALUE_LENGTH = 8_192;
const MAX_TIMEOUT_MILLIS = 120_000;
const MAX_REDIRECTS = 5;
const methodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);
const requestSchema = z
  .object({
    url: z.string(),
    method: methodSchema,
    headers: z.record(z.string(), z.string()).optional(),
    body: z
      .union([
        z.instanceof(Uint8Array),
        z
          .object({
            byteLength: z.number().int().min(0).max(FILE_PAGE_LIMITS.fileBytes),
            sha256: z.string().regex(/^[a-f0-9]{64}$/u),
            open: z.custom<NodeVerifiedByteSource['open']>(
              (value) => typeof value === 'function',
            ),
            release: z.custom<NodeVerifiedByteSource['release']>(
              (value) => typeof value === 'function',
            ),
          })
          .strict(),
      ])
      .optional(),
    timeoutMillis: z.number(),
    maxRedirects: z.number(),
    maxResponseBytes: z.number(),
    sensitiveValues: z.array(z.string()).optional(),
    navigation: z
      .object({
        origin: z
          .url()
          .max(2048)
          .refine((value) => new URL(value).origin === value),
        link: z.boolean(),
      })
      .strict()
      .optional(),
    signal: z
      .custom<AbortSignal>((value) => safeInstanceOf(value, AbortSignal))
      .optional(),
    beforeDispatch: z.custom<() => Promise<void>>(
      (value) => typeof value === 'function',
    ),
  })
  .strict();
const headerNamePattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const blockedRequestHeaders = new Set([
  'accept-encoding',
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export type ParsedSecureHttpRequest = Required<
  Omit<
    SecureHttpRequest,
    'body' | 'headers' | 'sensitiveValues' | 'signal' | 'navigation'
  >
> &
  Pick<SecureHttpRequest, 'body' | 'signal' | 'navigation'> &
  Readonly<{
    headers: Readonly<Record<string, string>>;
    sensitiveValues: readonly string[];
  }>;

function assertRequestBounds(request: z.output<typeof requestSchema>): void {
  if (
    !Number.isInteger(request.timeoutMillis) ||
    request.timeoutMillis < 1 ||
    request.timeoutMillis > MAX_TIMEOUT_MILLIS
  )
    throw new Error('invalid request timeout');
  if (
    !Number.isInteger(request.maxRedirects) ||
    request.maxRedirects < 0 ||
    request.maxRedirects > MAX_REDIRECTS
  )
    throw new Error('invalid redirect limit');
  if (
    !Number.isInteger(request.maxResponseBytes) ||
    request.maxResponseBytes < 1 ||
    request.maxResponseBytes > MAX_RESPONSE_BYTES
  )
    throw new Error('invalid response byte limit');
  if (
    (request.body?.byteLength ?? 0) >
    (request.body instanceof Uint8Array
      ? MAX_REQUEST_BODY_BYTES
      : FILE_PAGE_LIMITS.fileBytes)
  )
    throw new Error('request body exceeds byte limit');
}

function assertRequestMethodBodyPolicy(
  request: z.output<typeof requestSchema>,
): void {
  if (
    (request.method === 'GET' || request.method === 'HEAD') &&
    request.body !== undefined
  )
    throw new Error('request method does not allow a body');
}

function parseHeaders(
  input: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const normalized = new Map<string, string>();
  let bytes = 0;
  for (const [name, value] of Object.entries(input)) {
    const lower = name.toLowerCase();
    const invalidHeader =
      !headerNamePattern.test(name) ||
      blockedRequestHeaders.has(lower) ||
      value.length < 1 ||
      value.length > MAX_HEADER_VALUE_LENGTH ||
      !isSerializableHttpHeaderValue(value) ||
      normalized.has(lower);
    if (invalidHeader) throw new Error('invalid request header');
    bytes += utf8ByteLength(`${lower}:${value}\r\n`);
    normalized.set(lower, value);
  }
  if (normalized.size > MAX_HEADER_COUNT || bytes > MAX_HEADER_BYTES)
    throw new Error('request headers exceed limits');
  return Object.freeze(
    Object.fromEntries(
      [...normalized.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  );
}

function parseSensitiveValues(values: readonly string[]): readonly string[] {
  if (
    values.length > MAX_SENSITIVE_VALUE_COUNT ||
    values.some(
      (value) => value.length < 1 || value.length > MAX_SENSITIVE_VALUE_LENGTH,
    )
  )
    throw new Error('invalid sensitive values');
  return Object.freeze(
    [...new Set(values)].sort((left, right) => right.length - left.length),
  );
}

export function parseRequest(
  input: SecureHttpRequest,
): ParsedSecureHttpRequest {
  try {
    const parsed = requestSchema.parse(input);
    assertRequestBounds(parsed);
    if (
      parsed.navigation !== undefined &&
      new URL(parsed.url).origin !== parsed.navigation.origin
    )
      throw new Error('Navigation origin mismatch');
    assertRequestMethodBodyPolicy(parsed);
    return Object.freeze({
      url: parsed.url,
      ...(parsed.navigation === undefined
        ? {}
        : { navigation: parsed.navigation }),
      method: parsed.method,
      headers: parseHeaders(parsed.headers ?? {}),
      ...(parsed.body === undefined
        ? {}
        : {
            body:
              parsed.body instanceof Uint8Array
                ? new Uint8Array(parsed.body)
                : parsed.body,
          }),
      timeoutMillis: parsed.timeoutMillis,
      maxRedirects: parsed.maxRedirects,
      maxResponseBytes: parsed.maxResponseBytes,
      sensitiveValues: parseSensitiveValues(parsed.sensitiveValues ?? []),
      ...(parsed.signal === undefined ? {} : { signal: parsed.signal }),
      beforeDispatch: parsed.beforeDispatch,
    });
  } catch (error: unknown) {
    const secureError = inspectSecureHttpError(error);
    if (secureError !== undefined) throw secureError.error;
    throw failure(SECURE_HTTP_ERROR_CODE.invalidRequest, {
      possiblyDispatched: false,
      ambiguous: false,
      cause: error,
    });
  }
}
