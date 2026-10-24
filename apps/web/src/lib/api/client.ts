import { csrfTokenSchema } from '@pertexo/contracts';
import { ApiError, isApiError, protocolError } from './error';
import {
  requestIdFrom,
  mediaType,
  readJson,
  decodeSuccess,
  errorForResponse,
  type ApiResponseDecoder,
} from './transport/responses';
import { submitNativeDownload } from './transport/download';
import { requestController } from './transport/request-controller';

type ApiPath = `/v1${string}`;
type ApiMethod = 'DELETE' | 'GET' | 'HEAD' | 'PATCH' | 'POST' | 'PUT';

type ApiRequestBase = Readonly<{
  path: ApiPath;
  method?: ApiMethod;
  body?: unknown;
  headers?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  timeoutMs?: number;
  csrf?: 'session' | 'external';
  decodeProblem?: ApiResponseDecoder<unknown>;
}>;

export type ApiJsonRequest<Value> = ApiRequestBase &
  Readonly<{
    response: Readonly<{
      kind: 'json';
      decode: ApiResponseDecoder<Value>;
    }>;
  }>;

export type ApiEmptyRequest = ApiRequestBase &
  Readonly<{ response: Readonly<{ kind: 'empty' }> }>;

export type ApiStreamRequest = ApiRequestBase &
  Readonly<{
    response: Readonly<{
      kind: 'stream';
      mediaType: 'text/event-stream';
    }>;
  }>;

export type ApiByteStream = Readonly<{
  body: ReadableStream<Uint8Array>;
  close: () => void;
}>;

export interface ApiClient {
  request<Value>(request: ApiJsonRequest<Value>): Promise<Value>;
  request(request: ApiEmptyRequest): Promise<void>;
  stream(request: ApiStreamRequest): Promise<ApiByteStream>;
  download(request: Readonly<{ path: ApiPath; body: unknown }>): void;
}

type ApiClientOptions = Readonly<{
  fetch: typeof globalThis.fetch;
  readCsrfToken: () => string | undefined;
  defaultTimeoutMs?: number;
}>;

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 300_000;
const MUTATING_METHODS = new Set<ApiMethod>(['DELETE', 'PATCH', 'POST', 'PUT']);
const TRANSPORT_HEADERS = new Set([
  'accept',
  'authorization',
  'content-type',
  'cookie',
  'x-csrf-token',
]);

function validatePath(path: string): void {
  if (path !== '/v1' && !path.startsWith('/v1/'))
    throw protocolError('API requests must use a same-origin /v1 path.');
  if (
    path.includes('\\') ||
    Array.from(path).some((character) => character.charCodeAt(0) <= 0x20)
  )
    throw protocolError('API requests must use a valid relative path.');
}

function validateTimeout(timeoutMs: number): void {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_TIMEOUT_MS
  )
    throw protocolError(
      `API request timeout must be between 1 and ${String(MAX_TIMEOUT_MS)} milliseconds.`,
    );
}

function createHeaders(
  request: ApiJsonRequest<unknown> | ApiEmptyRequest | ApiStreamRequest,
  method: ApiMethod,
  readCsrfToken: () => string | undefined,
): Headers {
  let headers: Headers;
  try {
    headers = new Headers(request.headers);
  } catch (cause) {
    throw protocolError('API request headers are invalid.', { cause });
  }
  for (const name of TRANSPORT_HEADERS)
    if (headers.has(name))
      throw protocolError(`The ${name} header is owned by the API transport.`);

  headers.set(
    'accept',
    request.response.kind === 'stream'
      ? 'text/event-stream, application/problem+json'
      : 'application/json, application/problem+json',
  );
  if (request.body !== undefined)
    headers.set('content-type', 'application/json');

  if (MUTATING_METHODS.has(method) && request.csrf !== 'external') {
    let token: string | undefined;
    try {
      token = readCsrfToken();
    } catch (cause) {
      throw protocolError('The CSRF cookie could not be read.', { cause });
    }
    const parsed = csrfTokenSchema.safeParse(token);
    if (!parsed.success)
      throw protocolError('A valid CSRF cookie is required for this request.');
    headers.set('x-csrf-token', parsed.data);
  }
  return headers;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function throwTransportFailure({
  error,
  timedOut,
  requestSignal,
}: Readonly<{
  error: unknown;
  timedOut: boolean;
  requestSignal: AbortSignal | undefined;
}>): never {
  if (isApiError(error)) throw error;
  if (timedOut)
    throw new ApiError({
      kind: 'timeout',
      message: 'The API request timed out.',
      cause: error,
    });
  if (isAborted(requestSignal))
    throw new ApiError({
      kind: 'canceled',
      message: 'The API request was canceled.',
      cause: error,
    });
  throw new ApiError({
    kind: 'network',
    message: 'The API could not be reached.',
    cause: error,
  });
}

function serializeBody(
  request: ApiJsonRequest<unknown> | ApiEmptyRequest,
  method: ApiMethod,
): string | undefined {
  if (request.body === undefined) return undefined;
  if (method === 'GET' || method === 'HEAD')
    throw protocolError(`${method} requests cannot include a JSON body.`);
  try {
    const body: unknown = JSON.stringify(request.body);
    if (typeof body !== 'string')
      throw new TypeError('JSON serialization returned undefined');
    return body;
  } catch (cause) {
    throw protocolError('The API request body is not valid JSON.', { cause });
  }
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  validateTimeout(defaultTimeoutMs);

  async function request<Value>(request: ApiJsonRequest<Value>): Promise<Value>;
  async function request(request: ApiEmptyRequest): Promise<void>;
  async function request<Value>(
    request: ApiJsonRequest<Value> | ApiEmptyRequest,
  ): Promise<Value | void> {
    validatePath(request.path);
    const method = request.method ?? 'GET';
    const timeoutMs = request.timeoutMs ?? defaultTimeoutMs;
    validateTimeout(timeoutMs);
    if (isAborted(request.signal))
      throw new ApiError({
        kind: 'canceled',
        message: 'The API request was canceled.',
      });
    const body = serializeBody(request, method);
    const headers = createHeaders(request, method, options.readCsrfToken);

    const call = requestController(request.signal, timeoutMs, 'api-timeout');

    try {
      const response = await options.fetch(request.path, {
        method,
        headers,
        credentials: 'same-origin',
        signal: call.signal,
        ...(body === undefined ? {} : { body }),
      });
      if (call.timedOut())
        throw new ApiError({
          kind: 'timeout',
          message: 'The API request timed out.',
        });
      if (isAborted(request.signal))
        throw new ApiError({
          kind: 'canceled',
          message: 'The API request was canceled.',
        });
      if (!response.ok)
        throw await errorForResponse(response, request.decodeProblem);
      if (request.response.kind === 'empty') return;
      return decodeSuccess(
        request.response.decode,
        await readJson(response),
        response,
      );
    } catch (error) {
      throwTransportFailure({
        error,
        timedOut: call.timedOut(),
        requestSignal: request.signal,
      });
    } finally {
      call.dispose();
    }
  }

  async function stream(request: ApiStreamRequest): Promise<ApiByteStream> {
    validatePath(request.path);
    const method = request.method ?? 'GET';
    if (method !== 'GET' || request.body !== undefined)
      throw protocolError('Event streams must use GET without a request body.');
    const timeoutMs = request.timeoutMs ?? defaultTimeoutMs;
    validateTimeout(timeoutMs);
    if (isAborted(request.signal))
      throw new ApiError({
        kind: 'canceled',
        message: 'The API request was canceled.',
      });
    const headers = createHeaders(request, method, options.readCsrfToken);
    const call = requestController(
      request.signal,
      timeoutMs,
      'api-stream-timeout',
    );
    try {
      const response = await options.fetch(request.path, {
        method,
        headers,
        credentials: 'same-origin',
        signal: call.signal,
      });
      call.stopTimer();
      if (!response.ok)
        throw await errorForResponse(response, request.decodeProblem);
      if (mediaType(response) !== request.response.mediaType) {
        call.abort();
        throw protocolError(
          'The server returned an unexpected stream content type.',
          { status: response.status, requestId: requestIdFrom(response) },
        );
      }
      if (response.body === null) {
        call.abort();
        throw protocolError('The server returned an empty event stream.', {
          status: response.status,
          requestId: requestIdFrom(response),
        });
      }
      return Object.freeze({
        body: response.body,
        close: () => {
          call.abort();
          call.dispose();
        },
      });
    } catch (error) {
      call.dispose();
      throwTransportFailure({
        error,
        timedOut: call.timedOut(),
        requestSignal: request.signal,
      });
    }
  }

  function download(input: Readonly<{ path: ApiPath; body: unknown }>): void {
    validatePath(input.path);
    const request = { ...input, response: { kind: 'empty' as const } };
    const headers = createHeaders(request, 'POST', options.readCsrfToken);
    const payload = serializeBody(request, 'POST');
    if (payload === undefined)
      throw protocolError('A download request body is required.');
    const token = headers.get('x-csrf-token');
    if (token === null)
      throw protocolError('A valid CSRF cookie is required for this request.');
    submitNativeDownload(input.path, payload, token);
  }
  return Object.freeze({ request, stream, download });
}
