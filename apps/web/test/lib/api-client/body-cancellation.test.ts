import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApiClient } from '../../../src/lib/api/client';

import { readBrowserCsrfToken } from '../../../src/lib/api/transport/csrf';

import {
  apiErrorFrom,
  commonProblem,
  csrfToken,
  fetchMock,
  jsonResponse,
  problemResponse,
} from './fixture';

afterEach(() => {
  vi.useRealTimers();
});

describe('browser API transport', () => {
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

describe('native streamed downloads', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it('submits authenticated same-origin forms without fetching or buffering the response', () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const submitted: {
      path: string;
      method: string;
      target: string;
      payload: FormData;
    }[] = [];
    vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(function (
      this: HTMLFormElement,
    ) {
      submitted.push({
        path: this.getAttribute('action') ?? '',
        method: this.method,
        target: this.target,
        payload: new FormData(this),
      });
    });
    const client = createApiClient({ fetch, readCsrfToken: () => csrfToken });
    client.download({ path: '/v1/example/export', body: { filters: [] } });
    expect(fetch).not.toHaveBeenCalled();
    expect(submitted[0]).toMatchObject({
      path: '/v1/example/export',
      method: 'post',
      target: '_blank',
    });
    expect(submitted[0]?.payload.get('payload')).toBe('{"filters":[]}');
    expect(submitted[0]?.payload.get('csrfToken')).toBe(csrfToken);
    expect(document.querySelector('form')).toBeNull();
  });
  it('refuses unsafe paths and absent CSRF before starting a download', () => {
    const submit = vi.spyOn(HTMLFormElement.prototype, 'submit');
    const client = createApiClient({
      fetch: vi.fn(),
      readCsrfToken: () => undefined,
    });
    expect(() => {
      client.download({ path: '/v1/example/export', body: {} });
    }).toThrow(/CSRF/u);
    expect(() => {
      client.download({ path: '/v1/../export', body: {} });
    }).toThrow();
    expect(submit).not.toHaveBeenCalled();
  });
});
