import { mock } from 'node:test';
import timers from 'node:timers/promises';
import { afterEach, expect, it } from 'vitest';
import type {
  SecureHttpBodyConsumer,
  SecureHttpRequest,
  SecureHttpResponse,
} from '../../../src/server.js';
import { executePagination } from '../../../src/http-request/pagination/execute.js';

afterEach(() => {
  mock.timers.reset();
});
it('waits exactly the configured delay before fetching the next page', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const requested: string[] = [];
  const client = {
    executeStreaming: async <Body>(
      request: SecureHttpRequest,
      consume: SecureHttpBodyConsumer<Body>,
    ): Promise<SecureHttpResponse<Body>> => {
      requested.push(request.url);
      const bytes = new TextEncoder().encode(
        JSON.stringify({ data: requested.length === 1 ? [1] : [] }),
      );
      const body = await consume({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: (async function* () {
          await Promise.resolve();
          yield bytes;
        })(),
        bodyEncoding: 'utf8',
        finalUrl: 'https://example.test',
        navigation: { url: request.url },
        redirectCount: 0,
        signal: request.signal ?? new AbortController().signal,
      });
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body,
        bodyEncoding: 'utf8',
        finalUrl: 'https://example.test',
        redirectCount: 0,
      };
    },
  };
  const running = executePagination({
    client,
    request: {
      url: 'https://example.test/items',
      method: 'GET',
      timeoutMillis: 1000,
      maxRedirects: 0,
      maxResponseBytes: 1024,
      beforeDispatch: () => Promise.resolve(),
    },
    pagination: {
      mode: 'page',
      parameter: 'page',
      start: 1,
      itemsPath: '$.data',
      maxPages: 3,
      delayMillis: 250,
    },
    inlineBytes: 1024,
    checkResponse: () => undefined,
  });
  await timers.setImmediate();
  expect(requested).toHaveLength(1);
  mock.timers.tick(249);
  await timers.setImmediate();
  expect(requested).toHaveLength(1);
  mock.timers.tick(1);
  expect(await running).toMatchObject({
    items: [1],
    pageCount: 2,
    complete: true,
  });
  expect(requested.map((url) => new URL(url).searchParams.get('page'))).toEqual(
    ['1', '2'],
  );
});
