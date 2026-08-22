import { z } from 'zod';

import {
  assertPublicAddress,
  normalizeUrlHostname,
  type ResolvedAddress,
} from './address-policy.js';

const MAX_URL_BYTES = 2_048;
const MAX_REQUEST_BODY_BYTES = 1_048_576;
const MAX_RESPONSE_BYTES = 10_485_760;
const MAX_HEADER_BYTES = 32_768;
const MAX_TIMEOUT_MILLIS = 120_000;
const MAX_REDIRECTS = 5;

const methodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);
const secureHttpRequestSchema = z
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
const safeResponseHeaders = new Set([
  'content-language',
  'content-type',
  'etag',
  'last-modified',
  'ratelimit-limit',
  'ratelimit-remaining',
  'ratelimit-reset',
  'retry-after',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
]);

export const SECURE_HTTP_ERROR_CODE = Object.freeze({
  canceled: 'canceled',
  dispatchEvidenceFailed: 'dispatch_evidence_failed',
  dnsFailed: 'dns_failed',
  invalidRequest: 'invalid_request',
  networkFailed: 'network_failed',
  redirectRejected: 'redirect_rejected',
  responseEncodingRejected: 'response_encoding_rejected',
  responseTooLarge: 'response_too_large',
  ssrfBlocked: 'ssrf_blocked',
  timedOut: 'timed_out',
} as const);

export type SecureHttpErrorCode =
  (typeof SECURE_HTTP_ERROR_CODE)[keyof typeof SECURE_HTTP_ERROR_CODE];

export class SecureHttpError extends Error {
  public override readonly name = 'SecureHttpError';

  public constructor(
    public readonly code: SecureHttpErrorCode,
    public readonly classification: 'ambiguous' | 'definite_failure',
    public readonly possiblyDispatched: boolean,
  ) {
    super(`Secure HTTP request failed: ${code}`);
  }
}

export type SecureHttpRequest = Readonly<{
  url: string;
  method: 'DELETE' | 'GET' | 'HEAD' | 'PATCH' | 'POST' | 'PUT';
  headers?: Readonly<Record<string, string>>;
  body?: Uint8Array;
  timeoutMillis: number;
  maxRedirects: number;
  maxResponseBytes: number;
  sensitiveValues?: readonly string[];
  signal?: AbortSignal;
  beforeDispatch(): Promise<void>;
}>;

export type SecureHttpResponse = Readonly<{
  status: number;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
  bodyEncoding: 'base64' | 'utf8';
  finalUrl: string;
  redirectCount: number;
}>;

export interface SecureHttpResolver {
  resolve(hostname: string): Promise<readonly ResolvedAddress[]>;
}

export type SecureHttpTransportRequest = Readonly<{
  url: URL;
  address: ResolvedAddress;
  method: SecureHttpRequest['method'];
  headers: Readonly<Record<string, string>>;
  body?: Uint8Array;
  timeoutMillis: number;
  signal?: AbortSignal;
}>;

export type SecureHttpTransportResponse = Readonly<{
  status: number;
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  body: AsyncIterable<Uint8Array>;
  close(): void;
}>;

export interface SecureHttpTransport {
  dispatch(
    request: SecureHttpTransportRequest,
  ): Promise<SecureHttpTransportResponse>;
}

export class SecureHttpClient {
  public constructor(
    private readonly resolver: SecureHttpResolver,
    private readonly transport: SecureHttpTransport,
  ) {}

  public async execute(input: SecureHttpRequest): Promise<SecureHttpResponse> {
    const parsed = parseRequest(input);
    const timeoutSignal = AbortSignal.timeout(parsed.timeoutMillis);
    const executionSignal =
      parsed.signal === undefined
        ? timeoutSignal
        : AbortSignal.any([parsed.signal, timeoutSignal]);
    let url = parseTargetUrl(parsed.url);
    let method = parsed.method;
    let body = parsed.body;
    let headers = parsed.headers;
    let redirectCount = 0;
    let markerCommitted = false;

    for (;;) {
      assertNotAborted(executionSignal, markerCommitted, false);
      const address = await this.resolvePublic(
        url,
        markerCommitted,
        executionSignal,
      );
      if (!markerCommitted) {
        try {
          await raceWithSignal(
            parsed.beforeDispatch(),
            executionSignal,
            false,
            false,
          );
          markerCommitted = true;
        } catch (error: unknown) {
          if (error instanceof SecureHttpError) throw error;
          throw failure(
            SECURE_HTTP_ERROR_CODE.dispatchEvidenceFailed,
            false,
            false,
            error,
          );
        }
      }
      let response: SecureHttpTransportResponse;
      try {
        response = await raceWithSignal(
          this.transport.dispatch({
            url,
            address,
            method,
            headers,
            ...(body === undefined ? {} : { body }),
            timeoutMillis: parsed.timeoutMillis,
            signal: executionSignal,
          }),
          executionSignal,
          true,
          true,
        );
      } catch (error: unknown) {
        if (error instanceof SecureHttpError) throw error;
        throw mapTransportError(error, executionSignal);
      }
      if (
        !Number.isInteger(response.status) ||
        response.status < 100 ||
        response.status > 599
      ) {
        response.close();
        throw failure(SECURE_HTTP_ERROR_CODE.networkFailed, true, true);
      }

      const location = redirectLocation(response);
      if (location !== undefined) {
        response.close();
        if (redirectCount >= parsed.maxRedirects)
          throw failure(SECURE_HTTP_ERROR_CODE.redirectRejected, true, false);
        const next = parseRedirectUrl(location, url);
        if (url.protocol === 'https:' && next.protocol !== 'https:')
          throw failure(SECURE_HTTP_ERROR_CODE.redirectRejected, true, false);
        if (parsed.sensitiveValues.length > 0 && next.origin !== url.origin)
          throw failure(SECURE_HTTP_ERROR_CODE.redirectRejected, true, false);
        ({ method, body, headers } = redirectRequest(
          response.status,
          method,
          body,
          headers,
        ));
        url = next;
        redirectCount += 1;
        continue;
      }

      try {
        const responseBody = await raceWithSignal(
          readBoundedBody(
            response.body,
            parsed.maxResponseBytes,
            executionSignal,
          ),
          executionSignal,
          true,
          false,
        );
        const selectedHeaders = selectResponseHeaders(
          response.headers,
          parsed.sensitiveValues,
        );
        const contentType = selectedHeaders['content-type'] ?? '';
        const contentEncoding = response.headers['content-encoding'];
        if (
          contentEncoding !== undefined &&
          normalizedHeaderValue(contentEncoding).toLowerCase() !== 'identity'
        )
          throw failure(
            SECURE_HTTP_ERROR_CODE.responseEncodingRejected,
            true,
            false,
          );
        const textual = isTextualContentType(contentType);
        const safeBody = redactBytes(responseBody, parsed.sensitiveValues);
        if (safeBody.byteLength > parsed.maxResponseBytes)
          throw failure(SECURE_HTTP_ERROR_CODE.responseTooLarge, true, false);
        return Object.freeze({
          status: response.status,
          headers: selectedHeaders,
          body: safeBody,
          bodyEncoding: textual ? ('utf8' as const) : ('base64' as const),
          finalUrl: safeFinalUrl(url),
          redirectCount,
        });
      } finally {
        response.close();
      }
    }
  }

  private async resolvePublic(
    url: URL,
    possiblyDispatched: boolean,
    signal: AbortSignal,
  ): Promise<ResolvedAddress> {
    const hostname = normalizeUrlHostname(url.hostname);
    let addresses: readonly ResolvedAddress[];
    try {
      const literalFamily = literalAddressFamily(hostname);
      addresses =
        literalFamily === undefined
          ? await raceWithSignal(
              this.resolver.resolve(hostname),
              signal,
              possiblyDispatched,
              false,
            )
          : [{ address: hostname, family: literalFamily }];
    } catch (error: unknown) {
      if (error instanceof SecureHttpError) throw error;
      throw failure(
        SECURE_HTTP_ERROR_CODE.dnsFailed,
        possiblyDispatched,
        false,
        error,
      );
    }
    if (addresses.length === 0 || addresses.length > 16)
      throw failure(
        SECURE_HTTP_ERROR_CODE.dnsFailed,
        possiblyDispatched,
        false,
      );
    const validated: ResolvedAddress[] = [];
    try {
      for (const candidate of addresses) {
        const family = assertPublicAddress(candidate.address);
        if (family !== candidate.family)
          throw new Error('address family mismatch');
        validated.push(Object.freeze({ ...candidate }));
      }
    } catch (error: unknown) {
      throw failure(
        SECURE_HTTP_ERROR_CODE.ssrfBlocked,
        possiblyDispatched,
        false,
        error,
      );
    }
    validated.sort((left, right) =>
      `${String(left.family)}:${left.address}`.localeCompare(
        `${String(right.family)}:${right.address}`,
      ),
    );
    const selected = validated[0];
    if (selected === undefined)
      throw failure(
        SECURE_HTTP_ERROR_CODE.dnsFailed,
        possiblyDispatched,
        false,
      );
    return selected;
  }
}

function parseRequest(input: SecureHttpRequest): Required<
  Omit<SecureHttpRequest, 'body' | 'headers' | 'sensitiveValues' | 'signal'>
> &
  Pick<SecureHttpRequest, 'body' | 'signal'> &
  Readonly<{
    headers: Readonly<Record<string, string>>;
    sensitiveValues: readonly string[];
  }> {
  try {
    const parsed = secureHttpRequestSchema.parse(input);
    const method = parsed.method;
    if (
      !Number.isInteger(parsed.timeoutMillis) ||
      parsed.timeoutMillis < 1 ||
      parsed.timeoutMillis > MAX_TIMEOUT_MILLIS ||
      !Number.isInteger(parsed.maxRedirects) ||
      parsed.maxRedirects < 0 ||
      parsed.maxRedirects > MAX_REDIRECTS ||
      !Number.isInteger(parsed.maxResponseBytes) ||
      parsed.maxResponseBytes < 1 ||
      parsed.maxResponseBytes > MAX_RESPONSE_BYTES ||
      (parsed.body?.byteLength ?? 0) > MAX_REQUEST_BODY_BYTES ||
      ((method === 'GET' || method === 'HEAD') && parsed.body !== undefined)
    )
      throw new Error('invalid request limits');
    return Object.freeze({
      url: parsed.url,
      method,
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

function parseTargetUrl(value: string): URL {
  try {
    if (new TextEncoder().encode(value).byteLength > MAX_URL_BYTES)
      throw new Error('URL too long');
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      throw new Error('unsupported scheme');
    if (url.username !== '' || url.password !== '' || url.hash !== '')
      throw new Error('URL credentials and fragments are not allowed');
    return url;
  } catch (error: unknown) {
    throw failure(SECURE_HTTP_ERROR_CODE.invalidRequest, false, false, error);
  }
}

function parseRedirectUrl(location: string, current: URL): URL {
  try {
    return parseTargetUrl(new URL(location, current).toString());
  } catch (error: unknown) {
    throw failure(SECURE_HTTP_ERROR_CODE.redirectRejected, true, false, error);
  }
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
      value.length > 8_192 ||
      /[\r\n\0]/u.test(value) ||
      normalized.has(lower)
    )
      throw new Error('invalid request header');
    bytes += new TextEncoder().encode(`${lower}:${value}\r\n`).byteLength;
    normalized.set(lower, value);
  }
  if (normalized.size > 64 || bytes > MAX_HEADER_BYTES)
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
    values.length > 32 ||
    values.some((value) => value.length < 1 || value.length > 8_192)
  )
    throw new Error('invalid sensitive values');
  return Object.freeze(
    [...new Set(values)].sort((left, right) => right.length - left.length),
  );
}

function literalAddressFamily(hostname: string): 4 | 6 | undefined {
  try {
    return assertPublicAddress(hostname);
  } catch {
    if (/^[0-9a-f:.]+$/iu.test(hostname))
      throw failure(SECURE_HTTP_ERROR_CODE.ssrfBlocked, false, false);
    return undefined;
  }
}

function redirectLocation(
  response: SecureHttpTransportResponse,
): string | undefined {
  if (![301, 302, 303, 307, 308].includes(response.status)) return undefined;
  const location = response.headers.location;
  return typeof location === 'string' ? location : location?.[0];
}

function redirectRequest(
  status: number,
  method: SecureHttpRequest['method'],
  body: Uint8Array | undefined,
  headers: Readonly<Record<string, string>>,
): Readonly<{
  method: SecureHttpRequest['method'];
  body?: Uint8Array;
  headers: Readonly<Record<string, string>>;
}> {
  if (status === 307 || status === 308)
    return {
      method,
      ...(body === undefined ? {} : { body }),
      headers,
    };
  if (method !== 'GET' && method !== 'HEAD')
    throw failure(SECURE_HTTP_ERROR_CODE.redirectRejected, true, false);
  return { method, headers };
}

async function readBoundedBody(
  body: AsyncIterable<Uint8Array>,
  limit: number,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const chunk of body) {
      assertNotAborted(signal, true, false);
      size += chunk.byteLength;
      if (size > limit)
        throw failure(SECURE_HTTP_ERROR_CODE.responseTooLarge, true, false);
      chunks.push(new Uint8Array(chunk));
    }
  } catch (error: unknown) {
    if (error instanceof SecureHttpError) throw error;
    throw mapResponseStreamError(error, signal);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function selectResponseHeaders(
  headers: SecureHttpTransportResponse['headers'],
  sensitiveValues: readonly string[],
): Readonly<Record<string, string>> {
  const selected: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (!safeResponseHeaders.has(name) || rawValue === undefined) continue;
    const value = typeof rawValue === 'string' ? rawValue : rawValue.join(', ');
    selected[name] = redactText(value, sensitiveValues).slice(0, 2_048);
  }
  return Object.freeze(selected);
}

function isTextualContentType(contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  return (
    normalized.startsWith('text/') ||
    normalized.includes('json') ||
    normalized.includes('xml') ||
    normalized.includes('javascript') ||
    normalized.includes('x-www-form-urlencoded')
  );
}

function redactBytes(
  value: Uint8Array,
  sensitiveValues: readonly string[],
): Uint8Array {
  let result: Uint8Array = new Uint8Array(value);
  for (const sensitive of sensitiveValues) {
    result = replaceBytes(
      result,
      new TextEncoder().encode(sensitive),
      new TextEncoder().encode('[Redacted]'),
    );
  }
  return result;
}

function replaceBytes(
  value: Uint8Array,
  target: Uint8Array,
  replacement: Uint8Array,
): Uint8Array {
  const chunks: Uint8Array[] = [];
  let start = 0;
  let index = 0;
  while (index <= value.byteLength - target.byteLength) {
    if (matchesBytes(value, target, index)) {
      chunks.push(value.slice(start, index), replacement);
      index += target.byteLength;
      start = index;
    } else index += 1;
  }
  if (chunks.length === 0) return value;
  chunks.push(value.slice(start));
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function matchesBytes(
  value: Uint8Array,
  target: Uint8Array,
  offset: number,
): boolean {
  if (target.byteLength === 0) return false;
  for (let index = 0; index < target.byteLength; index += 1) {
    if (value[offset + index] !== target[index]) return false;
  }
  return true;
}

function redactText(value: string, sensitiveValues: readonly string[]): string {
  let result = value;
  for (const sensitive of sensitiveValues)
    result = result.replaceAll(sensitive, '[Redacted]');
  return result;
}

function safeFinalUrl(url: URL): string {
  return url.origin.slice(0, MAX_URL_BYTES);
}

function assertNotAborted(
  signal: AbortSignal | undefined,
  possiblyDispatched: boolean,
  ambiguous: boolean,
): void {
  if (signal?.aborted === true)
    throw abortFailure(signal, possiblyDispatched, ambiguous);
}

function mapTransportError(
  error: unknown,
  signal: AbortSignal | undefined,
): SecureHttpError {
  if (signal?.aborted === true) return abortFailure(signal, true, true);
  if (isTimeoutError(error))
    return failure(SECURE_HTTP_ERROR_CODE.timedOut, true, true, error);
  return failure(SECURE_HTTP_ERROR_CODE.networkFailed, true, true, error);
}

function mapResponseStreamError(
  error: unknown,
  signal: AbortSignal | undefined,
): SecureHttpError {
  if (signal?.aborted === true) return abortFailure(signal, true, false);
  if (isTimeoutError(error))
    return failure(SECURE_HTTP_ERROR_CODE.timedOut, true, false, error);
  return failure(SECURE_HTTP_ERROR_CODE.networkFailed, true, false, error);
}

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (('code' in error && error.code === 'ETIMEDOUT') ||
      error.name === 'TimeoutError')
  );
}

function failure(
  code: SecureHttpErrorCode,
  possiblyDispatched: boolean,
  ambiguous: boolean,
  cause?: unknown,
): SecureHttpError {
  void cause;
  return new SecureHttpError(
    code,
    ambiguous ? 'ambiguous' : 'definite_failure',
    possiblyDispatched,
  );
}

function raceWithSignal<T>(
  work: Promise<T>,
  signal: AbortSignal,
  possiblyDispatched: boolean,
  ambiguous: boolean,
): Promise<T> {
  if (signal.aborted)
    return Promise.reject(abortFailure(signal, possiblyDispatched, ambiguous));
  return new Promise<T>((resolve, reject) => {
    const aborted = (): void => {
      reject(abortFailure(signal, possiblyDispatched, ambiguous));
    };
    signal.addEventListener('abort', aborted, { once: true });
    void work.then(
      (value) => {
        signal.removeEventListener('abort', aborted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', aborted);
        reject(
          error instanceof Error
            ? error
            : new Error('Secure HTTP operation failed'),
        );
      },
    );
  });
}

function abortFailure(
  signal: AbortSignal,
  possiblyDispatched: boolean,
  ambiguous: boolean,
): SecureHttpError {
  const timedOut =
    signal.reason instanceof Error && signal.reason.name === 'TimeoutError';
  return failure(
    timedOut
      ? SECURE_HTTP_ERROR_CODE.timedOut
      : SECURE_HTTP_ERROR_CODE.canceled,
    possiblyDispatched,
    ambiguous,
  );
}

function normalizedHeaderValue(value: string | readonly string[]): string {
  return typeof value === 'string' ? value : value.join(', ');
}
