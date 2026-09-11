import { z } from 'zod';
import { isSerializableHttpHeaderValue } from './header-value.js';
import {
  SECURE_HTTP_ERROR_CODE,
  SecureHttpError,
  failure,
} from './secure-http-error.js';
import type { SecureHttpRequest } from './secure-http.js';

const MAX_REQUEST_BODY_BYTES = 1_048_576;
const MAX_RESPONSE_BYTES = 10_485_760;
const MAX_HEADER_BYTES = 32_768;
const MAX_HEADER_COUNT = 64;
const MAX_HEADER_VALUE_LENGTH = 8_192;
const MAX_SENSITIVE_VALUE_COUNT = 32;
const MAX_SENSITIVE_VALUE_LENGTH = 8_192;
const MAX_TIMEOUT_MILLIS = 120_000;
const MAX_REDIRECTS = 5;
const methodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);
const requestSchema = z
  .object({
    url: z.string(),
    method: methodSchema,
    headers: z.record(z.string(), z.string()).optional(),
    body: z.instanceof(Uint8Array).optional(),
    timeoutMillis: z.number(),
    maxRedirects: z.number(),
    maxResponseBytes: z.number(),
    sensitiveValues: z.array(z.string()).optional(),
    signal: z
      .custom<AbortSignal>((value) => value instanceof AbortSignal)
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
  Omit<SecureHttpRequest, 'body' | 'headers' | 'sensitiveValues' | 'signal'>
> &
  Pick<SecureHttpRequest, 'body' | 'signal'> &
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
  if ((request.body?.byteLength ?? 0) > MAX_REQUEST_BODY_BYTES)
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
    if (
      !headerNamePattern.test(name) ||
      blockedRequestHeaders.has(lower) ||
      value.length < 1 ||
      value.length > MAX_HEADER_VALUE_LENGTH ||
      !isSerializableHttpHeaderValue(value) ||
      normalized.has(lower)
    )
      throw new Error('invalid request header');
    bytes += new TextEncoder().encode(`${lower}:${value}\r\n`).byteLength;
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
    assertRequestMethodBodyPolicy(parsed);
    return Object.freeze({
      url: parsed.url,
      method: parsed.method,
      headers: parseHeaders(parsed.headers ?? {}),
      ...(parsed.body === undefined
        ? {}
        : { body: new Uint8Array(parsed.body) }),
      timeoutMillis: parsed.timeoutMillis,
      maxRedirects: parsed.maxRedirects,
      maxResponseBytes: parsed.maxResponseBytes,
      sensitiveValues: parseSensitiveValues(parsed.sensitiveValues ?? []),
      ...(parsed.signal === undefined ? {} : { signal: parsed.signal }),
      beforeDispatch: parsed.beforeDispatch,
    });
  } catch (error: unknown) {
    if (error instanceof SecureHttpError) throw error;
    throw failure(SECURE_HTTP_ERROR_CODE.invalidRequest, false, false, error);
  }
}
