import {
  apiProblemSchema,
  apiProblemShape,
  type ApiProblem,
} from '@pertexo/contracts/schemas/errors';
import { csrfTokenSchema } from '@pertexo/contracts/schemas/transport';
import { ApiError, isApiError } from './api-error';
import { requestController } from './request-controller';

type ApiPath = `/v1${string}`;
type ApiMethod = 'DELETE' | 'GET' | 'HEAD' | 'PATCH' | 'POST' | 'PUT';

type ApiResponseMetadata = Readonly<{
  status: number;
  header(name: string): string | null;
}>;

type ApiResponseDecoder<Value> = (
  value: unknown,
  metadata: ApiResponseMetadata,
) => Value;

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
}

type ApiClientOptions = Readonly<{
  fetch: typeof globalThis.fetch;
  readCsrfToken: () => string | undefined;
  defaultTimeoutMs?: number;
}>;

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_RETRY_AFTER_SECONDS = 300;
const MUTATING_METHODS = new Set<ApiMethod>(['DELETE', 'PATCH', 'POST', 'PUT']);
const TRANSPORT_HEADERS = new Set([
  'accept',
  'authorization',
  'content-type',
  'cookie',
  'x-csrf-token',
]);

function protocolError(
  message: string,
  options: Readonly<{
    status?: number;
    requestId?: string | undefined;
    retryAfterMs?: number | undefined;
    cause?: unknown;
  }> = {},
) {
  return new ApiError({ kind: 'protocol', message, ...options });
}

function requestIdFrom(response: Response): string | undefined {
  const parsed = apiProblemShape.requestId.safeParse(
    response.headers.get('x-request-id'),
  );
  return parsed.success ? parsed.data : undefined;
}

function retryAfterMsFrom(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (value === null || !/^[1-9][0-9]{0,2}$/u.test(value)) return undefined;
  const seconds = Number(value);
  return seconds <= MAX_RETRY_AFTER_SECONDS ? seconds * 1_000 : undefined;
}

function metadataFor(response: Response): ApiResponseMetadata {
  return Object.freeze({
    status: response.status,
    header: (name: string) => response.headers.get(name),
  });
}

function mediaType(response: Response): string | undefined {
  return response.headers
    .get('content-type')
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase();
}

function isJsonMediaType(value: string | undefined): boolean {
  return (
    value === 'application/json' ||
    (value?.startsWith('application/') === true && value.endsWith('+json'))
  );
}

async function readJson(response: Response): Promise<unknown> {
  if (!isJsonMediaType(mediaType(response)))
    throw protocolError('The server returned an unexpected content type.', {
      status: response.status,
      requestId: requestIdFrom(response),
      retryAfterMs: retryAfterMsFrom(response),
    });

  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw protocolError('The server returned malformed JSON.', {
      status: response.status,
      requestId: requestIdFrom(response),
      retryAfterMs: retryAfterMsFrom(response),
      cause: error,
    });
  }
}

function decodeSuccess<Value>(
  decoder: ApiResponseDecoder<Value>,
  value: unknown,
  response: Response,
): Value {
  try {
    return decoder(value, metadataFor(response));
  } catch (error) {
    throw protocolError('The server response did not match its contract.', {
      status: response.status,
      requestId: requestIdFrom(response),
      cause: error,
    });
  }
}

function tryDecodeProblem(
  decoder: ApiResponseDecoder<unknown>,
  value: unknown,
  response: Response,
): unknown {
  try {
    return decoder(value, metadataFor(response));
  } catch {
    return undefined;
  }
}

function commonProblemFrom(value: unknown): ApiProblem | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = Object.fromEntries(
    [
      'type',
      'title',
      'status',
      'detail',
      'instance',
      'code',
      'requestId',
      'errors',
    ].flatMap((name) =>
      name in value ? [[name, Reflect.get(value, name)] as const] : [],
    ),
  );
  const parsed = apiProblemSchema.safeParse(record);
  return parsed.success ? parsed.data : undefined;
}

async function errorForResponse(
  response: Response,
  decoder?: ApiResponseDecoder<unknown>,
): Promise<ApiError> {
  const requestId = requestIdFrom(response);
  const retryAfterMs = retryAfterMsFrom(response);
  if (mediaType(response) !== 'application/problem+json')
    return protocolError('The server returned an unexpected error response.', {
      status: response.status,
      requestId,
      retryAfterMs,
    });

  const text = await response.text();
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (cause) {
    return protocolError('The server returned malformed problem details.', {
      status: response.status,
      requestId,
      retryAfterMs,
      cause,
    });
  }

  const problemDetails =
    decoder === undefined
      ? undefined
      : tryDecodeProblem(decoder, value, response);
  const commonProblem = apiProblemSchema.safeParse(value);
  const problem =
    commonProblemFrom(problemDetails) ??
    (commonProblem.success ? commonProblem.data : undefined);
  if (problem?.status !== response.status)
    return protocolError('The server returned invalid problem details.', {
      status: response.status,
      requestId,
      retryAfterMs,
    });

  return new ApiError({
    kind: 'problem',
    message: problem.title,
    status: response.status,
    requestId: problem.requestId,
    retryAfterMs,
    problem,
    problemDetails: problemDetails ?? problem,
  });
}

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

function throwTransportFailure(
  error: unknown,
  timedOut: boolean,
  requestSignal: AbortSignal | undefined,
): never {
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
      throwTransportFailure(error, call.timedOut(), request.signal);
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
      throwTransportFailure(error, call.timedOut(), request.signal);
    }
  }

  return Object.freeze({ request, stream });
}
