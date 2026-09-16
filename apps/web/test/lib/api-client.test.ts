import { afterEach, describe, expect, it, vi } from 'vitest';
import { isApiError, type ApiError } from '../../src/lib/api/api-error';
import { createApiClient } from '../../src/lib/api/client';
import { readBrowserCsrfToken } from '../../src/lib/api/csrf';

const csrfToken = 'csrf-token-1234567890';
const requestId = 'request-123';

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(value), { ...init, headers });
}

function problemResponse(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/problem+json');
  return new Response(JSON.stringify(value), { status: 400, ...init, headers });
}

function commonProblem(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    type: 'urn:pertexo:problem:request.invalid',
    title: 'Invalid request',
    status: 400,
    code: 'request.invalid',
    requestId,
    ...overrides,
  };
}

function fetchMock(response: Response) {
  return vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
}

async function apiErrorFrom(
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

afterEach(() => {
  vi.useRealTimers();
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
      const error = await apiErrorFrom(
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

    const error = await apiErrorFrom(
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
    const currentEtag = `"draft-v1.${'a'.repeat(43)}"`;
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

    const error = await apiErrorFrom(
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

    const error = await apiErrorFrom(
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

    const error = await apiErrorFrom(
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
    await apiErrorFrom(
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
    const timedRequest = apiErrorFrom(
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
    const networkError = await apiErrorFrom(
      networkClient.request({
        path: '/v1/examples',
        response: { kind: 'json', decode: (value) => value },
      }),
      'network',
    );
    expect(networkError.message).toBe('The API could not be reached.');
  });

  it.each(['success', 'problem'] as const)(
    'preserves cancellation while reading a %s response body after headers',
    async (kind) => {
      const canceled = new AbortController();
      let transportSignal: AbortSignal | undefined;
      const response =
        kind === 'success'
          ? jsonResponse({ value: true })
          : problemResponse(commonProblem());
      vi.spyOn(response, 'text').mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            transportSignal?.addEventListener(
              'abort',
              () => {
                reject(new DOMException('aborted', 'AbortError'));
              },
              { once: true },
            );
          }),
      );
      const fetch = vi.fn<typeof globalThis.fetch>((_input, init) => {
        transportSignal = init?.signal ?? undefined;
        return Promise.resolve(response);
      });
      const client = createApiClient({
        fetch,
        readCsrfToken: () => undefined,
      });
      const request = apiErrorFrom(
        client.request({
          path: '/v1/examples',
          signal: canceled.signal,
          response: { kind: 'json', decode: (value) => value },
        }),
        'canceled',
      );
      await Promise.resolve();
      await Promise.resolve();
      canceled.abort();
      await request;
      expect(transportSignal?.aborted).toBe(true);
    },
  );

  it.each(['success', 'problem'] as const)(
    'preserves network classification while reading a %s response body',
    async (kind) => {
      const response =
        kind === 'success'
          ? jsonResponse({ value: true })
          : problemResponse(commonProblem());
      vi.spyOn(response, 'text').mockRejectedValue(
        new TypeError('response body disconnected'),
      );
      const client = createApiClient({
        fetch: fetchMock(response),
        readCsrfToken: () => undefined,
      });

      await apiErrorFrom(
        client.request({
          path: '/v1/examples',
          response: { kind: 'json', decode: (value) => value },
        }),
        'network',
      );
    },
  );

  it('preserves timeout classification during a success-body read and cleans up after completion', async () => {
    vi.useFakeTimers();
    let transportSignal: AbortSignal | undefined;
    const hanging = jsonResponse({ value: true });
    vi.spyOn(hanging, 'text').mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          transportSignal?.addEventListener(
            'abort',
            () => {
              reject(new DOMException('aborted', 'AbortError'));
            },
            { once: true },
          );
        }),
    );
    const fetch = vi.fn<typeof globalThis.fetch>((_input, init) => {
      transportSignal = init?.signal ?? undefined;
      return Promise.resolve(hanging);
    });
    const client = createApiClient({ fetch, readCsrfToken: () => undefined });
    const timed = apiErrorFrom(
      client.request({
        path: '/v1/examples',
        timeoutMs: 25,
        response: { kind: 'json', decode: (value) => value },
      }),
      'timeout',
    );
    await vi.advanceTimersByTimeAsync(25);
    await timed;

    let completedSignal: AbortSignal | undefined;
    const completedClient = createApiClient({
      fetch: vi.fn<typeof globalThis.fetch>((_input, init) => {
        completedSignal = init?.signal ?? undefined;
        return Promise.resolve(jsonResponse({ value: true }));
      }),
      readCsrfToken: () => undefined,
    });
    await expect(
      completedClient.request({
        path: '/v1/examples',
        timeoutMs: 25,
        response: { kind: 'json', decode: (value) => value },
      }),
    ).resolves.toEqual({ value: true });
    await vi.advanceTimersByTimeAsync(25);
    expect(completedSignal?.aborted).toBe(false);
  });

  it('preserves timeout classification during a problem-body read', async () => {
    vi.useFakeTimers();
    let transportSignal: AbortSignal | undefined;
    const hanging = problemResponse(commonProblem());
    vi.spyOn(hanging, 'text').mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          transportSignal?.addEventListener(
            'abort',
            () => {
              reject(new DOMException('aborted', 'AbortError'));
            },
            { once: true },
          );
        }),
    );
    const client = createApiClient({
      fetch: vi.fn<typeof globalThis.fetch>((_input, init) => {
        transportSignal = init?.signal ?? undefined;
        return Promise.resolve(hanging);
      }),
      readCsrfToken: () => undefined,
    });
    const timed = apiErrorFrom(
      client.request({
        path: '/v1/examples',
        timeoutMs: 25,
        response: { kind: 'json', decode: (value) => value },
      }),
      'timeout',
    );

    await vi.advanceTimersByTimeAsync(25);
    await timed;
  });

  it('rejects cross-origin paths, transport headers and missing CSRF before fetch', async () => {
    const fetch = fetchMock(jsonResponse({}));
    const client = createApiClient({ fetch, readCsrfToken: () => undefined });
    const requests = [
      client.request({
        path: 'https://example.com/v1/data' as '/v1/data',
        response: { kind: 'json', decode: (value) => value },
      }),
      client.request({
        path: '/v1/data',
        headers: { 'x-csrf-token': csrfToken },
        response: { kind: 'json', decode: (value) => value },
      }),
      client.request({
        path: '/v1/data',
        headers: { authorization: 'Bearer browser-token' },
        response: { kind: 'json', decode: (value) => value },
      }),
      client.request({
        path: '/v1/data',
        method: 'POST',
        response: { kind: 'empty' },
      }),
    ];

    for (const request of requests) await apiErrorFrom(request, 'protocol');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('opens a same-origin event stream with an explicit resume cursor', async () => {
    const body = new ReadableStream<Uint8Array>();
    const fetch = fetchMock(
      new Response(body, {
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      }),
    );
    const client = createApiClient({ fetch, readCsrfToken: () => undefined });

    const stream = await client.stream({
      path: '/v1/workspaces/a/runs/b/events',
      headers: { 'Last-Event-ID': '7' },
      response: { kind: 'stream', mediaType: 'text/event-stream' },
    });

    expect(stream.body).toBe(body);
    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
    expect(headers.get('accept')).toBe(
      'text/event-stream, application/problem+json',
    );
    expect(headers.get('last-event-id')).toBe('7');
    expect(fetch.mock.calls[0]?.[1]?.credentials).toBe('same-origin');
    stream.close();
  });

  it('normalizes event-stream HTTP and media failures', async () => {
    const problemClient = createApiClient({
      fetch: fetchMock(problemResponse(commonProblem())),
      readCsrfToken: () => undefined,
    });
    await apiErrorFrom(
      problemClient.stream({
        path: '/v1/events',
        response: { kind: 'stream', mediaType: 'text/event-stream' },
      }),
      'problem',
    );

    const mediaClient = createApiClient({
      fetch: fetchMock(jsonResponse({ events: [] })),
      readCsrfToken: () => undefined,
    });
    await apiErrorFrom(
      mediaClient.stream({
        path: '/v1/events',
        response: { kind: 'stream', mediaType: 'text/event-stream' },
      }),
      'protocol',
    );
  });
});

describe('CSRF cookie adapter', () => {
  it('reads and validates only the named readable cookie', () => {
    expect(
      readBrowserCsrfToken(
        `other=value; pertexo_csrf=${encodeURIComponent(csrfToken)}`,
      ),
    ).toBe(csrfToken);
    expect(readBrowserCsrfToken('pertexo_csrf=short')).toBeUndefined();
    expect(readBrowserCsrfToken('other=value')).toBeUndefined();
  });
});
