import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SECURE_HTTP_ERROR_CODE,
  SecureHttpClient,
  type SecureHttpResolver,
  type SecureHttpTransport,
  type SecureHttpTransportResponse,
} from '../src/server.js';

const encoder = new TextEncoder();

function response(body: AsyncIterable<Uint8Array>): Readonly<{
  value: SecureHttpTransportResponse;
  close: ReturnType<typeof vi.fn>;
}> {
  const close = vi.fn();
  return {
    value: Object.freeze({
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body,
      close,
    }),
    close,
  };
}

function request(signal?: AbortSignal) {
  return {
    url: 'https://api.example.test/stream',
    method: 'GET' as const,
    timeoutMillis: 30_000,
    maxRedirects: 0,
    maxResponseBytes: 1_024,
    sensitiveValues: [],
    ...(signal === undefined ? {} : { signal }),
    beforeDispatch: () => Promise.resolve(),
  };
}

function clientFor(fixture: SecureHttpTransportResponse): SecureHttpClient {
  const resolver: SecureHttpResolver = {
    resolve: () =>
      Promise.resolve([{ address: '8.8.8.8', family: 4 as const }]),
  };
  const transport: SecureHttpTransport = {
    dispatch: () => Promise.resolve(fixture),
  };
  return new SecureHttpClient(resolver, transport);
}

describe('secure HTTP streamed-body deadline/error mapping', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps a controlled monotonic deadline reached before a yielded chunk', async () => {
    const fixture = response({
      async *[Symbol.asyncIterator]() {
        await Promise.resolve();
        yield encoder.encode('late chunk');
      },
    });
    const now = vi
      .spyOn(performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(30_000);

    await expect(
      clientFor(fixture.value).execute(request()),
    ).rejects.toMatchObject({
      code: SECURE_HTTP_ERROR_CODE.timedOut,
      classification: 'ambiguous',
      possiblyDispatched: true,
    });
    expect(now).toHaveBeenCalled();
    expect(fixture.close).toHaveBeenCalledOnce();
  });

  it('observes an aborting iterator rejection before the outer abort race', async () => {
    const controller = new AbortController();
    const iteratorError = new Error('iterator failed');
    const fixture = response({
      [Symbol.asyncIterator]: () => ({
        next: () => {
          controller.abort(new Error('caller cancellation'));
          return Promise.reject<IteratorResult<Uint8Array>>(iteratorError);
        },
      }),
    });

    await expect(
      clientFor(fixture.value).execute(request(controller.signal)),
    ).rejects.toMatchObject({
      code: SECURE_HTTP_ERROR_CODE.canceled,
      classification: 'ambiguous',
      possiblyDispatched: true,
    });
    expect(fixture.close).toHaveBeenCalledOnce();
  });

  it('maps an ETIMEDOUT iterator rejection separately from dispatch timeout', async () => {
    const iteratorError = Object.assign(new Error('body timed out'), {
      code: 'ETIMEDOUT',
    });
    const fixture = response({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject<IteratorResult<Uint8Array>>(iteratorError),
      }),
    });

    await expect(
      clientFor(fixture.value).execute(request()),
    ).rejects.toMatchObject({
      code: SECURE_HTTP_ERROR_CODE.timedOut,
      classification: 'ambiguous',
      possiblyDispatched: true,
    });
    expect(fixture.close).toHaveBeenCalledOnce();
  });
});
