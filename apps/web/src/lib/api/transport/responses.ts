import {
  apiProblemSchema,
  apiProblemShape,
  type ApiProblem,
} from '@pertexo/contracts';
import { ApiError, protocolError } from '../error';

const MAX_RETRY_AFTER_SECONDS = 300;

type ApiResponseMetadata = Readonly<{
  status: number;
  header(name: string): string | null;
}>;

export type ApiResponseDecoder<Value> = (
  value: unknown,
  metadata: ApiResponseMetadata,
) => Value;

export function requestIdFrom(response: Response): string | undefined {
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

export function mediaType(response: Response): string | undefined {
  return response.headers
    .get('content-type')
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase();
}

function isJsonMediaType(value: string | undefined): boolean {
  const structuredJson =
    value !== undefined &&
    value.startsWith('application/') &&
    value.endsWith('+json');
  return value === 'application/json' || structuredJson;
}

export async function readJson(response: Response): Promise<unknown> {
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

export function decodeSuccess<Value>(
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

export async function errorForResponse(
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
