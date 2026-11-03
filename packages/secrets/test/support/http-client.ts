import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, vi, type Mock } from 'vitest';

import type { SecureHttpError } from '../../src/server.js';
import type {
  SecureHttpRequest,
  SecureHttpResolver,
  SecureHttpTransport,
  SecureHttpTransportRequest,
  SecureHttpTransportResponse,
} from '../../src/server.js';
export const encoder = new TextEncoder();
export const decoder = new TextDecoder();
export const execFileAsync = promisify(execFile);
export const packageDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../..',
);
export class FakeResolver implements SecureHttpResolver {
  public readonly calls: string[] = [];

  public constructor(
    private readonly answers: Readonly<
      Record<
        string,
        Error | readonly Readonly<{ address: string; family: 4 | 6 }>[]
      >
    >,
  ) {}

  public resolve(hostname: string) {
    this.calls.push(hostname);
    const answer = this.answers[hostname];
    if (answer instanceof Error) return Promise.reject(answer);
    if (answer === undefined)
      return Promise.reject(new Error('missing DNS fixture'));
    return Promise.resolve(answer);
  }
}
export class FakeTransport implements SecureHttpTransport {
  public readonly requests: SecureHttpTransportRequest[] = [];

  public constructor(
    private readonly handler: (
      request: SecureHttpTransportRequest,
      index: number,
    ) => Promise<SecureHttpTransportResponse>,
  ) {}

  public dispatch(request: SecureHttpTransportRequest) {
    const index = this.requests.length;
    this.requests.push(request);
    return this.handler(request, index);
  }
}
export function transportResponse(
  status: number,
  headers: SecureHttpTransportResponse['headers'] = {},
  chunks: readonly string[] = ['ok'],
): { response: SecureHttpTransportResponse; close: Mock<() => void> } {
  const close = vi.fn<() => void>();
  const response: SecureHttpTransportResponse = Object.freeze({
    status,
    headers,
    body: {
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) {
          await Promise.resolve();
          yield encoder.encode(chunk);
        }
      },
    },
    close,
  });
  return { response, close };
}
export function request(
  overrides: Partial<SecureHttpRequest> = {},
): SecureHttpRequest {
  return {
    url: 'https://api.example.test/v1/resource?opaque=query-secret',
    method: 'GET',
    timeoutMillis: 1_000,
    maxRedirects: 3,
    maxResponseBytes: 1_024,
    beforeDispatch: () => Promise.resolve(),
    ...overrides,
  };
}
export function expectSecureFailure(
  promise: Promise<unknown>,
  expected: Readonly<
    Partial<Pick<SecureHttpError, 'classification' | 'possiblyDispatched'>> & {
      code: string;
    }
  >,
) {
  return expect(promise).rejects.toMatchObject(expected);
}
