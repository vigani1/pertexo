import { createServer, validateHeaderValue } from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { assertPublicAddress } from '../src/http/address-policy.js';
import {
  NodeHttpTransport,
  SECURE_HTTP_ERROR_CODE,
  SecureHttpClient,
  type SecureHttpError,
  type SecureHttpRequest,
  type SecureHttpResolver,
  type SecureHttpTransport,
  type SecureHttpTransportRequest,
  type SecureHttpTransportResponse,
} from '../src/server.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

class FakeResolver implements SecureHttpResolver {
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

class FakeTransport implements SecureHttpTransport {
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

function transportResponse(
  status: number,
  headers: SecureHttpTransportResponse['headers'] = {},
  chunks: readonly string[] = ['ok'],
) {
  const close = vi.fn();
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

function request(
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

function expectSecureFailure(
  promise: Promise<unknown>,
  expected: Readonly<
    Partial<Pick<SecureHttpError, 'classification' | 'possiblyDispatched'>> & {
      code: string;
    }
  >,
) {
  return expect(promise).rejects.toMatchObject(expected);
}

describe('public network address policy', () => {
  it.each([
    '0.1.2.3',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.0.2.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '64:ff9b::c000:201',
    '100::1',
    '2001:db8::1',
    '2002:0a00:1::1',
    '3fff::1',
    'fc00::1',
    'fe80::1',
    'ff00::1',
  ])('blocks non-public address %s', (address) => {
    expect(() => assertPublicAddress(address)).toThrow();
  });

  it.each([
    ['8.8.8.8', 4],
    ['1.1.1.1', 4],
    ['2606:4700:4700::1111', 6],
    ['2001:4860:4860::8888', 6],
  ] as const)('accepts public address %s', (address, family) => {
    expect(assertPublicAddress(address)).toBe(family);
  });
});

describe('secure HTTP client', () => {
  it('commits dispatch evidence before one pinned request and redacts bounded output', async () => {
    const order: string[] = [];
    const resolver = new FakeResolver({
      'api.example.test': [
        { address: '2606:4700:4700::1111', family: 6 },
        { address: '8.8.8.8', family: 4 },
      ],
    });
    const fixture = transportResponse(
      200,
      {
        'content-type': 'application/json; charset=utf-8',
        etag: 'Bearer provider-secret',
        'set-cookie': 'session=provider-secret',
      },
      ['{"echo":"provider-secret"}'],
    );
    const transport = new FakeTransport(() => {
      order.push('transport');
      return Promise.resolve(fixture.response);
    });
    const client = new SecureHttpClient(resolver, transport);

    const response = await client.execute(
      request({
        headers: {
          Authorization: 'Bearer provider-secret',
          Accept: 'application/json',
        },
        sensitiveValues: ['provider-secret'],
        beforeDispatch: () => {
          order.push('marker');
          return Promise.resolve();
        },
      }),
    );

    expect(order).toEqual(['marker', 'transport']);
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]).toMatchObject({
      address: { address: '8.8.8.8', family: 4 },
      headers: {
        accept: 'application/json',
        authorization: 'Bearer provider-secret',
      },
    });
    expect(response).toMatchObject({
      status: 200,
      bodyEncoding: 'utf8',
      finalUrl: 'https://api.example.test',
      redirectCount: 0,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        etag: 'Bearer [Redacted]',
      },
    });
    expect(response.headers).not.toHaveProperty('set-cookie');
    expect(decoder.decode(response.body)).toBe('{"echo":"[Redacted]"}');
    expect(fixture.close).toHaveBeenCalledOnce();
  });

  it('streams bounded output with cross-chunk redaction and preserves safe consumer failures', async () => {
    const resolver = new FakeResolver({
      'api.example.test': [{ address: '8.8.8.8', family: 4 }],
    });
    const fixture = transportResponse(200, { 'content-type': 'text/plain' }, [
      'prefix-provider-',
      'secret-suffix',
    ]);
    const client = new SecureHttpClient(
      resolver,
      new FakeTransport(() => Promise.resolve(fixture.response)),
    );
    const response = await client.executeStreaming(
      request({ sensitiveValues: ['provider-secret'] }),
      async (stream) => {
        const chunks: Uint8Array[] = [];
        for await (const chunk of stream.body) chunks.push(chunk);
        return decoder.decode(Buffer.concat(chunks));
      },
    );
    expect(response.body).toBe('prefix-[Redacted]-suffix');
    expect(fixture.close).toHaveBeenCalledOnce();

    const consumerFailure = new Error('safe storage failure');
    const failedFixture = transportResponse(200, {}, ['streamed']);
    await expect(
      new SecureHttpClient(
        resolver,
        new FakeTransport(() => Promise.resolve(failedFixture.response)),
      ).executeStreaming(request(), async (stream) => {
        for await (const _chunk of stream.body) {
          void _chunk;
          throw consumerFailure;
        }
        return undefined;
      }),
    ).rejects.toBe(consumerFailure);
    expect(failedFixture.close).toHaveBeenCalledOnce();
  });

  it.each([
    { url: 'file:///etc/passwd' },
    { url: 'https://user:password@api.example.test/' },
    { url: 'https://api.example.test/#secret' },
    { headers: { Host: 'metadata.internal' } },
    { headers: { 'Accept-Encoding': 'gzip' } },
    { headers: { 'X-Test': 'valid\r\nInjected: value' } },
    { method: 'GET' as const, body: encoder.encode('unexpected') },
    { maxRedirects: 6 },
    { maxResponseBytes: 10_485_761 },
    { sensitiveValues: [42 as never] },
    { unexpected: true },
  ])('rejects invalid input before DNS or dispatch: $url', async (override) => {
    const resolver = new FakeResolver({});
    const transport = new FakeTransport(() =>
      Promise.reject(new Error('must not dispatch')),
    );
    const beforeDispatch = vi.fn().mockResolvedValue(undefined);
    await expectSecureFailure(
      new SecureHttpClient(resolver, transport).execute(
        request({ ...override, beforeDispatch }),
      ),
      {
        code: SECURE_HTTP_ERROR_CODE.invalidRequest,
        possiblyDispatched: false,
      },
    );
    expect(resolver.calls).toEqual([]);
    expect(beforeDispatch).not.toHaveBeenCalled();
    expect(transport.requests).toEqual([]);
  });

  it('admits exactly the control-byte header values Node can serialize', async () => {
    const invalidCodePoints = [
      ...Array.from({ length: 32 }, (_, codePoint) => codePoint),
      0x7f,
    ].filter((codePoint) => codePoint !== 0x09);
    const resolver = new FakeResolver({
      'api.example.test': [{ address: '8.8.8.8', family: 4 }],
    });

    for (const codePoint of invalidCodePoints) {
      const value = `left${String.fromCharCode(codePoint)}right`;
      expect(() => {
        validateHeaderValue('x-test', value);
      }).toThrow();
      await expectSecureFailure(
        new SecureHttpClient(
          resolver,
          new FakeTransport(() =>
            Promise.reject(new Error('must not dispatch')),
          ),
        ).execute(request({ headers: { 'x-test': value } })),
        {
          code: SECURE_HTTP_ERROR_CODE.invalidRequest,
          possiblyDispatched: false,
        },
      );
    }

    expect(() => {
      validateHeaderValue('x-test', 'left\tright');
    }).not.toThrow();
  });

  it('clears the owned request body after success and failure', async () => {
    const resolver = new FakeResolver({
      'api.example.test': [{ address: '8.8.8.8', family: 4 }],
    });
    const observed: Uint8Array[] = [];
    const successfulTransport = new FakeTransport((transportRequest) => {
      if (transportRequest.body !== undefined)
        observed.push(transportRequest.body);
      return Promise.resolve(transportResponse(200).response);
    });
    await new SecureHttpClient(resolver, successfulTransport).execute(
      request({ method: 'POST', body: encoder.encode('secret-body') }),
    );
    expect(observed[0]?.every((byte) => byte === 0)).toBe(true);

    const failedTransport = new FakeTransport((transportRequest) => {
      if (transportRequest.body !== undefined)
        observed.push(transportRequest.body);
      return Promise.reject(new Error('network failure'));
    });
    await expectSecureFailure(
      new SecureHttpClient(resolver, failedTransport).execute(
        request({ method: 'POST', body: encoder.encode('secret-body') }),
      ),
      { code: SECURE_HTTP_ERROR_CODE.networkFailed, possiblyDispatched: true },
    );
    expect(observed[1]?.every((byte) => byte === 0)).toBe(true);
  });

  it('enforces the output budget while expanding redactions', async () => {
    const resolver = new FakeResolver({
      'api.example.test': [{ address: '8.8.8.8', family: 4 }],
    });
    const response = transportResponse(200, {}, ['aaaaaaaaaa']);
    await expectSecureFailure(
      new SecureHttpClient(
        resolver,
        new FakeTransport(() => Promise.resolve(response.response)),
      ).execute(request({ maxResponseBytes: 10, sensitiveValues: ['a'] })),
      {
        code: SECURE_HTTP_ERROR_CODE.responseTooLarge,
        possiblyDispatched: true,
      },
    );
    expect(response.close).toHaveBeenCalledOnce();
  });

  it('rejects blocked literals, private DNS answers, and mixed answer sets', async () => {
    const resolver = new FakeResolver({
      'private.example.test': [{ address: '10.0.0.8', family: 4 }],
      'mixed.example.test': [
        { address: '8.8.8.8', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ],
    });
    const transport = new FakeTransport(() =>
      Promise.reject(new Error('must not dispatch')),
    );
    const client = new SecureHttpClient(resolver, transport);
    for (const url of [
      'http://127.0.0.1/',
      'http://[::1]/',
      'https://private.example.test/',
      'https://mixed.example.test/',
    ]) {
      await expectSecureFailure(client.execute(request({ url })), {
        code: SECURE_HTTP_ERROR_CODE.ssrfBlocked,
        possiblyDispatched: false,
      });
    }
    expect(transport.requests).toEqual([]);
  });

  it('re-resolves and pins every redirect hop without inheriting trust', async () => {
    const resolver = new FakeResolver({
      'first.example.test': [{ address: '8.8.8.8', family: 4 }],
      'second.example.test': [{ address: '2606:4700:4700::1111', family: 6 }],
    });
    const first = transportResponse(307, {
      location: 'https://second.example.test/final?redirect-secret=value',
    });
    const second = transportResponse(204, {}, []);
    const transport = new FakeTransport((_input, index) =>
      Promise.resolve(index === 0 ? first.response : second.response),
    );
    const marker = vi.fn().mockResolvedValue(undefined);

    const response = await new SecureHttpClient(resolver, transport).execute(
      request({
        url: 'https://first.example.test/start',
        beforeDispatch: marker,
      }),
    );

    expect(resolver.calls).toEqual([
      'first.example.test',
      'second.example.test',
    ]);
    expect(transport.requests.map(({ address }) => address)).toEqual([
      { address: '8.8.8.8', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ]);
    expect(marker).toHaveBeenCalledOnce();
    expect(response).toMatchObject({
      status: 204,
      redirectCount: 1,
      finalUrl: 'https://second.example.test',
    });
  });

  it('blocks a redirect whose fresh DNS result becomes private after possible dispatch', async () => {
    const resolver = new FakeResolver({
      'first.example.test': [{ address: '8.8.8.8', family: 4 }],
      'private.example.test': [{ address: '10.0.0.9', family: 4 }],
    });
    const redirect = transportResponse(302, {
      location: 'https://private.example.test/internal',
    });
    const transport = new FakeTransport(() =>
      Promise.resolve(redirect.response),
    );

    await expectSecureFailure(
      new SecureHttpClient(resolver, transport).execute(
        request({ url: 'https://first.example.test/' }),
      ),
      {
        code: SECURE_HTTP_ERROR_CODE.ssrfBlocked,
        classification: 'definite_failure',
        possiblyDispatched: true,
      },
    );
    expect(transport.requests).toHaveLength(1);
  });

  it('never forwards credential values across an origin-changing redirect', async () => {
    const resolver = new FakeResolver({
      'first.example.test': [{ address: '8.8.8.8', family: 4 }],
      'second.example.test': [{ address: '1.1.1.1', family: 4 }],
    });
    const redirect = transportResponse(307, {
      location: 'https://second.example.test/collect',
    });
    const transport = new FakeTransport(() =>
      Promise.resolve(redirect.response),
    );

    await expectSecureFailure(
      new SecureHttpClient(resolver, transport).execute(
        request({
          url: 'https://first.example.test/',
          headers: { authorization: 'Bearer connection-secret' },
          sensitiveValues: ['Bearer connection-secret'],
        }),
      ),
      {
        code: SECURE_HTTP_ERROR_CODE.redirectRejected,
        classification: 'definite_failure',
        possiblyDispatched: true,
      },
    );
    expect(transport.requests).toHaveLength(1);
    expect(resolver.calls).toEqual(['first.example.test']);
  });

  it.each([
    {
      status: 302,
      location: 'http://second.example.test/',
      method: 'GET' as const,
      code: 'https downgrade',
    },
    {
      status: 302,
      location: 'https://second.example.test/',
      method: 'POST' as const,
      code: 'unsafe method rewrite',
    },
  ])('rejects $code redirects', async ({ status, location, method }) => {
    const resolver = new FakeResolver({
      'first.example.test': [{ address: '8.8.8.8', family: 4 }],
    });
    const redirect = transportResponse(status, { location });
    const transport = new FakeTransport(() =>
      Promise.resolve(redirect.response),
    );
    await expectSecureFailure(
      new SecureHttpClient(resolver, transport).execute(
        request({
          url: 'https://first.example.test/',
          method,
          ...(method === 'POST' ? { body: encoder.encode('{}') } : {}),
        }),
      ),
      {
        code: SECURE_HTTP_ERROR_CODE.redirectRejected,
        possiblyDispatched: true,
      },
    );
  });

  it('bounds redirects and streamed response bytes', async () => {
    const resolver = new FakeResolver({
      'api.example.test': [{ address: '8.8.8.8', family: 4 }],
    });
    const redirect = transportResponse(307, { location: '/again' });
    await expectSecureFailure(
      new SecureHttpClient(
        resolver,
        new FakeTransport(() => Promise.resolve(redirect.response)),
      ).execute(request({ maxRedirects: 0 })),
      {
        code: SECURE_HTTP_ERROR_CODE.redirectRejected,
        possiblyDispatched: true,
      },
    );

    const oversized = transportResponse(200, {}, ['1234', '5678']);
    await expectSecureFailure(
      new SecureHttpClient(
        resolver,
        new FakeTransport(() => Promise.resolve(oversized.response)),
      ).execute(request({ maxResponseBytes: 7 })),
      {
        code: SECURE_HTTP_ERROR_CODE.responseTooLarge,
        classification: 'definite_failure',
        possiblyDispatched: true,
      },
    );
    expect(oversized.close).toHaveBeenCalledOnce();
  });

  it('redacts binary and short sensitive values and rejects encoded responses', async () => {
    const resolver = new FakeResolver({
      'api.example.test': [{ address: '8.8.8.8', family: 4 }],
    });
    const binary = transportResponse(
      200,
      { 'content-type': 'application/octet-stream' },
      ['prefix-!-suffix'],
    );
    const response = await new SecureHttpClient(
      resolver,
      new FakeTransport(() => Promise.resolve(binary.response)),
    ).execute(request({ sensitiveValues: ['!'] }));
    expect(response.bodyEncoding).toBe('base64');
    expect(decoder.decode(response.body)).toBe('prefix-[Redacted]-suffix');

    const encoded = transportResponse(200, {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
    });
    await expectSecureFailure(
      new SecureHttpClient(
        resolver,
        new FakeTransport(() => Promise.resolve(encoded.response)),
      ).execute(request()),
      {
        code: SECURE_HTTP_ERROR_CODE.responseEncodingRejected,
        classification: 'definite_failure',
        possiblyDispatched: true,
      },
    );
  });

  it('rejects excessive DNS answers and invalid HTTP status before accepting output', async () => {
    const excessive = new FakeResolver({
      'api.example.test': Array.from({ length: 17 }, () => ({
        address: '8.8.8.8',
        family: 4 as const,
      })),
    });
    const transport = new FakeTransport(() =>
      Promise.reject(new Error('must not dispatch')),
    );
    await expectSecureFailure(
      new SecureHttpClient(excessive, transport).execute(request()),
      {
        code: SECURE_HTTP_ERROR_CODE.dnsFailed,
        possiblyDispatched: false,
      },
    );

    const resolver = new FakeResolver({
      'api.example.test': [{ address: '8.8.8.8', family: 4 }],
    });
    const invalid = transportResponse(0);
    await expectSecureFailure(
      new SecureHttpClient(
        resolver,
        new FakeTransport(() => Promise.resolve(invalid.response)),
      ).execute(request()),
      {
        code: SECURE_HTTP_ERROR_CODE.networkFailed,
        classification: 'ambiguous',
        possiblyDispatched: true,
      },
    );
    expect(invalid.close).toHaveBeenCalledOnce();
  });

  it('keeps body timeout and network failure ambiguous after provider-confirmed success', async () => {
    const resolver = new FakeResolver({
      'api.example.test': [{ address: '8.8.8.8', family: 4 }],
    });
    const close = vi.fn();
    const response: SecureHttpTransportResponse = {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: {
        async *[Symbol.asyncIterator]() {
          await new Promise(() => undefined);
          yield encoder.encode('unreachable');
        },
      },
      close,
    };
    await expectSecureFailure(
      new SecureHttpClient(
        resolver,
        new FakeTransport(() => Promise.resolve(response)),
      ).execute(request({ timeoutMillis: 5 })),
      {
        code: SECURE_HTTP_ERROR_CODE.timedOut,
        classification: 'ambiguous',
        possiblyDispatched: true,
      },
    );
    expect(close).toHaveBeenCalledOnce();

    const streamFailure = new Error('response stream failed');
    const failedClose = vi.fn();
    const failedResponse: SecureHttpTransportResponse = {
      status: 200,
      headers: {},
      body: {
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.reject(streamFailure),
        }),
      },
      close: failedClose,
    };
    await expectSecureFailure(
      new SecureHttpClient(
        resolver,
        new FakeTransport(() => Promise.resolve(failedResponse)),
      ).execute(request()),
      {
        code: SECURE_HTTP_ERROR_CODE.networkFailed,
        classification: 'ambiguous',
        possiblyDispatched: true,
      },
    );
    expect(failedClose).toHaveBeenCalledOnce();
  });

  it('classifies marker, DNS, transport, cancellation, and total timeout failures safely', async () => {
    const publicResolver = new FakeResolver({
      'api.example.test': [{ address: '8.8.8.8', family: 4 }],
    });
    const unusedTransport = new FakeTransport(() =>
      Promise.reject(new Error('transport-internal-secret')),
    );
    const markerFailure = new SecureHttpClient(
      publicResolver,
      unusedTransport,
    ).execute(
      request({
        beforeDispatch: () =>
          Promise.reject(new Error('database-connection-secret')),
      }),
    );
    await expectSecureFailure(markerFailure, {
      code: SECURE_HTTP_ERROR_CODE.dispatchEvidenceFailed,
      classification: 'definite_failure',
      possiblyDispatched: false,
    });

    const dnsFailure = new SecureHttpClient(
      new FakeResolver({
        'api.example.test': new Error('resolver-host-secret'),
      }),
      unusedTransport,
    ).execute(request());
    await expectSecureFailure(dnsFailure, {
      code: SECURE_HTTP_ERROR_CODE.dnsFailed,
      possiblyDispatched: false,
    });

    const networkFailure = new SecureHttpClient(
      publicResolver,
      unusedTransport,
    ).execute(request());
    const networkError = await networkFailure.catch((error: unknown) => error);
    expect(networkError).toMatchObject({
      code: SECURE_HTTP_ERROR_CODE.networkFailed,
      classification: 'ambiguous',
      possiblyDispatched: true,
    });
    expect(networkError).not.toHaveProperty('cause');
    expect(JSON.stringify(networkError)).not.toContain(
      'transport-internal-secret',
    );

    const controller = new AbortController();
    controller.abort(new Error('caller-secret'));
    await expectSecureFailure(
      new SecureHttpClient(publicResolver, unusedTransport).execute(
        request({ signal: controller.signal }),
      ),
      {
        code: SECURE_HTTP_ERROR_CODE.canceled,
        possiblyDispatched: false,
      },
    );

    const hungTransport = new FakeTransport(() => new Promise(() => undefined));
    await expectSecureFailure(
      new SecureHttpClient(publicResolver, hungTransport).execute(
        request({ timeoutMillis: 5 }),
      ),
      {
        code: SECURE_HTTP_ERROR_CODE.timedOut,
        classification: 'ambiguous',
        possiblyDispatched: true,
      },
    );
  });

  it('does not report definite pre-dispatch cancellation while the marker can still commit', async () => {
    const controller = new AbortController();
    let releaseMarker: (() => void) | undefined;
    let committed = false;
    const markerStarted = vi.fn();
    const markerGate = new Promise<void>((resolve) => {
      releaseMarker = resolve;
    });
    const dispatch = vi.fn();
    const execution = new SecureHttpClient(
      new FakeResolver({
        'api.example.test': [{ address: '8.8.8.8', family: 4 }],
      }),
      { dispatch },
    ).execute(
      request({
        signal: controller.signal,
        beforeDispatch: async () => {
          markerStarted();
          await markerGate;
          committed = true;
        },
      }),
    );
    await vi.waitFor(() => {
      expect(markerStarted).toHaveBeenCalledOnce();
    });
    let settled = false;
    void execution
      .finally(() => {
        settled = true;
      })
      .catch(() => undefined);
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseMarker?.();
    await expectSecureFailure(execution, {
      code: SECURE_HTTP_ERROR_CODE.canceled,
      classification: 'ambiguous',
      possiblyDispatched: true,
    });
    expect(committed).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('Node HTTP transport', () => {
  const servers: ReturnType<typeof createServer>[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => {
              if (error === undefined) resolve();
              else reject(error);
            });
          }),
      ),
    );
  });

  it('connects only to the supplied pinned address while preserving the URL host', async () => {
    const server = createServer((incoming, response) => {
      response.setHeader('content-type', 'text/plain');
      response.end(incoming.headers.host ?? 'missing');
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('test server did not bind a TCP port');
    const transport = new NodeHttpTransport();
    const response = await transport.dispatch({
      url: new URL(`http://does-not-resolve.invalid:${String(address.port)}/`),
      address: { address: '127.0.0.1', family: 4 },
      method: 'GET',
      headers: {},
      timeoutMillis: 1_000,
    });
    const chunks: Uint8Array[] = [];
    for await (const chunk of response.body) chunks.push(chunk);
    response.close();
    expect(decoder.decode(Buffer.concat(chunks))).toBe(
      `does-not-resolve.invalid:${String(address.port)}`,
    );
  });
});
