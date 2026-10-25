import { expect, vi } from 'vitest';
import { isApiError, type ApiError } from '../../../src/lib/api/error';
export const csrfToken = 'csrf-token-1234567890';

export const requestId = 'request-123';

export function jsonResponse(
  value: unknown,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(value), { ...init, headers });
}

export function problemResponse(
  value: unknown,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/problem+json');
  return new Response(JSON.stringify(value), { status: 400, ...init, headers });
}

export function commonProblem(
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    type: 'urn:pertexo:problem:request.invalid',
    title: 'Invalid request',
    status: 400,
    code: 'request.invalid',
    requestId,
    ...overrides,
  };
}

export function fetchMock(response: Response) {
  return vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
}

export async function apiErrorFrom(
  promise: Promise<unknown>,
  kind: ApiError['kind'],
): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (!isApiError(error)) throw error;
    expect(error.kind).toBe(kind);
    return error;
  }
  throw new Error('Expected the API request to fail');
}
