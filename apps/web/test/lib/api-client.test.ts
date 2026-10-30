import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApiClient } from '../../src/lib/api/client';

import {
  expectApiError,
  commonProblem,
  csrfToken,
  fetchMock,
  jsonResponse,
  problemResponse,
  requestId,
} from './api-client/fixture';

afterEach(() => {
  vi.useRealTimers();
});

describe('external CSRF ownership', () => {
  it('allows a mutating request without a session CSRF cookie when declared', async () => {
    const fetch = fetchMock(jsonResponse({ accepted: true }));
    const client = createApiClient({ fetch, readCsrfToken: () => undefined });

    await expect(
      client.request({
        path: '/v1/invitation-acceptance/resolve',
        method: 'POST',
        csrf: 'external',
        headers: { 'X-Pertexo-Invitation-Request': 'resolve' },
        body: { token: 'opaque' },
        response: { kind: 'json', decode: (value) => value },
      }),
    ).resolves.toEqual({ accepted: true });

    const headers = fetch.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get('x-csrf-token')).toBeNull();
    expect(headers.get('x-pertexo-invitation-request')).toBe('resolve');
  });
});

describe('browser API transport', () => {
  it('decodes JSON through the caller contract and exposes response metadata', async () => {
    const fetch = fetchMock(
      jsonResponse({ value: 'accepted' }, { headers: { etag: '"draft-3"' } }),
    );
    const client = createApiClient({ fetch, readCsrfToken: () => undefined });

    await expect(
      client.request({
        path: '/v1/examples',
        response: {
          kind: 'json',
          decode: (value, metadata) => ({
            value: (value as { value?: unknown }).value,
            etag: metadata.header('etag'),
          }),
        },
      }),
    ).resolves.toEqual({ value: 'accepted', etag: '"draft-3"' });

    const call = fetch.mock.calls[0];
    expect(call?.[0]).toBe('/v1/examples');
    expect(call?.[1]?.credentials).toBe('same-origin');
    expect(call?.[1]?.method).toBe('GET');
    expect(new Headers(call?.[1]?.headers).get('accept')).toBe(
      'application/json, application/problem+json',
    );
  });
  it('serializes JSON and reads a fresh CSRF token for every mutation', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const tokens = ['csrf-token-1234567890', 'csrf-token-0987654321'];
    const readCsrfToken = vi.fn(() => tokens.shift());
    const client = createApiClient({ fetch, readCsrfToken });
    const request = {
      path: '/v1/examples' as const,
      method: 'POST' as const,
      body: { name: 'Example' },
      headers: { 'Idempotency-Key': 'one-logical-command' },
      response: { kind: 'empty' as const },
    };

    await client.request(request);
    await client.request(request);

    expect(readCsrfToken).toHaveBeenCalledTimes(2);
    for (const [index, call] of fetch.mock.calls.entries()) {
      const headers = new Headers(call[1]?.headers);
      expect(headers.get('content-type')).toBe('application/json');
      expect(headers.get('idempotency-key')).toBe('one-logical-command');
      expect(headers.get('x-csrf-token')).toBe(
        index === 0 ? 'csrf-token-1234567890' : 'csrf-token-0987654321',
      );
      expect(call[1]?.body).toBe('{"name":"Example"}');
    }
  });
  it('accepts an empty 204 response without parsing JSON', async () => {
    const fetch = fetchMock(new Response(null, { status: 204 }));
    const client = createApiClient({ fetch, readCsrfToken: () => csrfToken });

    await expect(
      client.request({
        path: '/v1/auth/logout',
        method: 'POST',
        response: { kind: 'empty' },
      }),
    ).resolves.toBeUndefined();
  });
  it('normalizes malformed JSON, unexpected media and decoder failures', async () => {
    const cases = [
      new Response('{', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      new Response('{}', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
      jsonResponse({ unexpected: true }),
    ];

    for (const response of cases) {
      const client = createApiClient({
        fetch: fetchMock(response),
        readCsrfToken: () => undefined,
      });
      const error = await expectApiError(
        client.request({
          path: '/v1/examples',
          response: {
            kind: 'json',
            decode: () => {
              throw new Error('private decoder detail');
            },
          },
        }),
        'protocol',
      );
      expect(error.message).not.toContain('private decoder detail');
    }
  });
  it('keeps a valid common problem and bounded Retry-After metadata', async () => {
    const client = createApiClient({
      fetch: fetchMock(
        problemResponse(commonProblem(), {
          headers: { 'retry-after': '17', 'x-request-id': requestId },
        }),
      ),
      readCsrfToken: () => undefined,
    });

    const error = await expectApiError(
      client.request({
        path: '/v1/examples',
        response: { kind: 'json', decode: (value) => value },
      }),
      'problem',
    );
    expect(error.problem?.code).toBe('request.invalid');
    expect(error.requestId).toBe(requestId);
    expect(error.retryAfterMs).toBe(17_000);
  });
  it('uses an endpoint decoder before the strict common problem decoder', async () => {
    const currentEtag = `"draft.${'a'.repeat(43)}"`;
    const conflict = commonProblem({
      type: 'urn:pertexo:problem:workflow.revision_conflict',
      title: 'Workflow revision conflict',
      status: 412,
      code: 'workflow.revision_conflict',
      currentRevision: 4,
      currentEtag,
    });
    const client = createApiClient({
      fetch: fetchMock(problemResponse(conflict, { status: 412 })),
      readCsrfToken: () => undefined,
    });

    const error = await expectApiError(
      client.request({
        path: '/v1/workspaces/a/workflows/b/draft',
        response: { kind: 'json', decode: (value) => value },
        decodeProblem: (value) => {
          if (
            typeof value !== 'object' ||
            value === null ||
            Reflect.get(value, 'currentRevision') !== 4 ||
            Reflect.get(value, 'currentEtag') !== currentEtag
          )
            throw new Error('invalid workflow conflict');
          return value;
        },
      }),
      'problem',
    );
    expect(error.problemDetails).toMatchObject({
      code: 'workflow.revision_conflict',
      currentRevision: 4,
      currentEtag,
    });
  });
  it('treats missing required response metadata as a protocol failure', async () => {
    const client = createApiClient({
      fetch: fetchMock(jsonResponse({ draft: true })),
      readCsrfToken: () => undefined,
    });

    const error = await expectApiError(
      client.request({
        path: '/v1/workspaces/a/workflows/b/draft',
        response: {
          kind: 'json',
          decode: (value, metadata) => {
            const etag = metadata.header('etag');
            if (etag === null) throw new Error('missing ETag');
            return { value, etag };
          },
        },
      }),
      'protocol',
    );
    expect(error.message).toBe(
      'The server response did not match its contract.',
    );
  });
  it('keeps safe headers when malformed problem details fall back to protocol failure', async () => {
    const client = createApiClient({
      fetch: fetchMock(
        problemResponse(
          { unsafe: '<html>' },
          {
            status: 503,
            headers: {
              'retry-after': '999',
              'x-request-id': 'safe-request-id',
            },
          },
        ),
      ),
      readCsrfToken: () => undefined,
    });

    const error = await expectApiError(
      client.request({
        path: '/v1/examples',
        response: { kind: 'json', decode: (value) => value },
      }),
      'protocol',
    );
    expect(error.requestId).toBe('safe-request-id');
    expect(error.retryAfterMs).toBeUndefined();
    expect(error.message).not.toContain('<html>');
  });
  it('distinguishes cancellation, timeout and network failures', async () => {
    const canceled = new AbortController();
    canceled.abort();
    const unusedFetch = fetchMock(jsonResponse({}));
    const client = createApiClient({
      fetch: unusedFetch,
      readCsrfToken: () => undefined,
    });
    await expectApiError(
      client.request({
        path: '/v1/examples',
        signal: canceled.signal,
        response: { kind: 'json', decode: (value) => value },
      }),
      'canceled',
    );
    expect(unusedFetch).not.toHaveBeenCalled();

    vi.useFakeTimers();
    const hangingFetch = vi.fn<typeof globalThis.fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    const timedClient = createApiClient({
      fetch: hangingFetch,
      readCsrfToken: () => undefined,
    });
    const timedRequest = expectApiError(
      timedClient.request({
        path: '/v1/examples',
        timeoutMs: 25,
        response: { kind: 'json', decode: (value) => value },
      }),
      'timeout',
    );
    await vi.advanceTimersByTimeAsync(25);
    await timedRequest;
    vi.useRealTimers();

    const networkClient = createApiClient({
      fetch: vi
        .fn<typeof globalThis.fetch>()
        .mockRejectedValue(new Error('private network detail')),
      readCsrfToken: () => undefined,
    });
    const networkError = await expectApiError(
      networkClient.request({
        path: '/v1/examples',
        response: { kind: 'json', decode: (value) => value },
      }),
      'network',
    );
    expect(networkError.message).toBe('The API could not be reached.');
  });
});
