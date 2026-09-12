import { describe, expect, it, vi } from 'vitest';

const fixtures = vi.hoisted(() => ({
  lookup: vi.fn(),
  httpRequest: vi.fn(),
  httpsRequest: vi.fn(),
}));

vi.mock('node:dns/promises', () => ({
  lookup: fixtures.lookup,
}));
vi.mock('node:http', () => ({
  default: { request: fixtures.httpRequest },
}));
vi.mock('node:https', () => ({
  default: { request: fixtures.httpsRequest },
}));

import { NodeDnsResolver, NodeHttpTransport } from '../src/server.js';

type RequestOptions = Readonly<{
  lookup: (
    hostname: string,
    options: Readonly<{ all?: boolean }>,
    callback: (...args: unknown[]) => void,
  ) => void;
  signal?: AbortSignal;
  [key: string]: unknown;
}>;

function responseFixture() {
  return {
    statusCode: 204,
    headers: { 'content-type': 'text/plain' },
    destroy: vi.fn(),
    [Symbol.asyncIterator]: async function* () {
      // The transport returns the native response as its body.
      await Promise.resolve();
      yield new Uint8Array();
    },
  };
}

function requestFixture(
  requestFunction: ReturnType<typeof vi.fn>,
  response: ReturnType<typeof responseFixture>,
  respond = true,
  expectedAddress = { address: '2001:4860:4860::8888', family: 6 },
) {
  const timeout = vi.fn();
  const once = vi.fn();
  const write = vi.fn();
  const destroy = vi.fn();
  const end = vi.fn();
  let errorListener: ((error: unknown) => void) | undefined;
  once.mockImplementation(
    (event: string, listener: (error: unknown) => void) => {
      if (event === 'error') errorListener = listener;
    },
  );
  destroy.mockImplementation((error?: unknown) => {
    if (error !== undefined) errorListener?.(error);
  });
  requestFunction.mockImplementationOnce(
    (
      url: URL,
      options: RequestOptions,
      callback: (value: typeof response) => void,
    ) => {
      end.mockImplementationOnce(() => {
        const allAnswers: unknown[] = [];
        options.lookup(url.hostname, { all: true }, (...args) => {
          allAnswers.push(args);
        });
        const singleAnswers: unknown[] = [];
        options.lookup(url.hostname, {}, (...args) => {
          singleAnswers.push(args);
        });
        if (respond) callback(response);
        expect(allAnswers).toEqual([[null, [expectedAddress]]]);
        expect(singleAnswers).toEqual([
          [null, expectedAddress.address, expectedAddress.family],
        ]);
      });
      return { setTimeout: timeout, once, write, destroy, end };
    },
  );
  return { timeout, once, write, destroy, end };
}

describe('Node DNS and HTTP adapters', () => {
  it('normalizes mixed DNS families into frozen public adapter values', async () => {
    fixtures.lookup.mockResolvedValueOnce([
      { address: '192.0.2.44', family: 4 },
      { address: '2001:4860:4860::8888', family: 6 },
    ]);

    const result = await new NodeDnsResolver().resolve('api.example.test');

    expect(fixtures.lookup).toHaveBeenCalledWith('api.example.test', {
      all: true,
      verbatim: true,
    });
    expect(result).toEqual([
      { address: '192.0.2.44', family: 4 },
      { address: '2001:4860:4860::8888', family: 6 },
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result[0])).toBe(true);
    expect(Object.isFrozen(result[1])).toBe(true);
  });

  it('selects HTTPS, pins both lookup forms, preserves hostname/SNI, and closes', async () => {
    const response = responseFixture();
    const request = requestFixture(fixtures.httpsRequest, response);
    const controller = new AbortController();
    const transportResponse = await new NodeHttpTransport().dispatch({
      url: new URL('https://api.example.test/v1'),
      address: { address: '2001:4860:4860::8888', family: 6 },
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: new TextEncoder().encode('request body'),
      timeoutMillis: 1_234,
      signal: controller.signal,
    });

    expect(fixtures.httpsRequest).toHaveBeenCalledOnce();
    expect(fixtures.httpRequest).not.toHaveBeenCalled();
    const [url, options] = fixtures.httpsRequest.mock.calls[0] as [
      URL,
      RequestOptions,
    ];
    expect(url.hostname).toBe('api.example.test');
    expect(options).toMatchObject({
      agent: false,
      headers: { 'content-type': 'text/plain' },
      maxHeaderSize: 32_768,
      method: 'POST',
      signal: controller.signal,
    });
    expect(request.timeout).toHaveBeenCalledWith(1_234, expect.any(Function));
    expect(request.write).toHaveBeenCalledWith(expect.any(Uint8Array));
    expect(request.end).toHaveBeenCalledOnce();
    expect(transportResponse.status).toBe(204);
    transportResponse.close();
    expect(response.destroy).toHaveBeenCalledOnce();
  });

  it('destroys and rejects on timeout or request error while forwarding cancellation', async () => {
    const timeoutResponse = responseFixture();
    const timeoutRequest = requestFixture(
      fixtures.httpRequest,
      timeoutResponse,
      false,
      { address: '8.8.8.8', family: 4 },
    );
    const timeoutPromise = new NodeHttpTransport().dispatch({
      url: new URL('http://api.example.test/v1'),
      address: { address: '8.8.8.8', family: 4 },
      method: 'GET',
      headers: {},
      timeoutMillis: 10,
    });
    const timeoutCallback = timeoutRequest.timeout.mock.calls[0]?.[1] as
      (() => void) | undefined;
    timeoutCallback?.();
    const timeoutError = timeoutRequest.destroy.mock.calls[0]?.[0] as Error;
    expect(timeoutError).toMatchObject({
      message: 'Secure HTTP request timed out',
      code: 'ETIMEDOUT',
    });
    await expect(timeoutPromise).rejects.toBe(timeoutError);

    const requestError = new Error('socket failure');
    const errorResponse = responseFixture();
    const errorRequest = requestFixture(
      fixtures.httpRequest,
      errorResponse,
      false,
      { address: '8.8.8.8', family: 4 },
    );
    const errorPromise = new NodeHttpTransport().dispatch({
      url: new URL('http://api.example.test/v1'),
      address: { address: '8.8.8.8', family: 4 },
      method: 'GET',
      headers: {},
      timeoutMillis: 10,
      signal: new AbortController().signal,
    });
    const errorListener = errorRequest.once.mock.calls[0]?.[1] as
      ((error: Error) => void) | undefined;
    errorListener?.(requestError);
    await expect(errorPromise).rejects.toBe(requestError);
  });
});
