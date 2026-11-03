import { describe, expect, it } from 'vitest';

import {
  SECURE_HTTP_ERROR_CODE,
  SecureHttpClient,
  SecureHttpError,
  type SecureHttpFailureObservation,
} from '../../../src/server.js';
import {
  decoder,
  FakeResolver,
  FakeTransport,
  transportResponse,
  request,
  expectSecureFailure,
} from '../../support/http-client.js';
describe('secure HTTP client', () => {
  it('keeps full page navigation private to the consumer after same-origin redirects', async () => {
    const transport = new FakeTransport((_request, index) =>
      Promise.resolve(
        index === 0
          ? transportResponse(302, { location: '/moved/page?cursor=private' })
              .response
          : transportResponse(200, {
              link: '</moved/next?cursor=opaque>; rel="next"',
            }).response,
      ),
    );
    const client = new SecureHttpClient(
      new FakeResolver({
        'api.example.test': [{ address: '8.8.8.8', family: 4 }],
      }),
      transport,
    );
    let navigation: unknown;
    const result = await client.executeStreaming(
      request({
        navigation: { origin: 'https://api.example.test', link: true },
      }),
      (stream) => {
        navigation = stream.navigation;
        return Promise.resolve('read');
      },
    );
    expect(navigation).toEqual({
      url: 'https://api.example.test/moved/page?cursor=private',
      link: '</moved/next?cursor=opaque>; rel="next"',
    });
    expect(result.finalUrl).toBe('https://api.example.test');
    expect(result.headers).not.toHaveProperty('link');
    expect(result).not.toHaveProperty('navigation');
  });
  it('blocks foreign redirects for paginated public requests before DNS or dispatch there', async () => {
    const resolver = new FakeResolver({
      'api.example.test': [{ address: '8.8.8.8', family: 4 }],
    });
    const transport = new FakeTransport(() =>
      Promise.resolve(
        transportResponse(302, {
          location: 'https://elsewhere.example.test/items',
        }).response,
      ),
    );
    const client = new SecureHttpClient(resolver, transport);
    await expectSecureFailure(
      client.execute(
        request({
          navigation: { origin: 'https://api.example.test', link: false },
        }),
      ),
      { code: SECURE_HTTP_ERROR_CODE.paginationOriginChanged },
    );
    expect(resolver.calls).toEqual(['api.example.test']);
    expect(transport.requests).toHaveLength(1);
  });
  it('refuses an oversized navigation header without silently truncating it', async () => {
    const response = transportResponse(200, {
      link: '<' + 'a'.repeat(8192) + '>; rel="next"',
    });
    const client = new SecureHttpClient(
      new FakeResolver({
        'api.example.test': [{ address: '8.8.8.8', family: 4 }],
      }),
      new FakeTransport(() => Promise.resolve(response.response)),
    );
    await expectSecureFailure(
      client.execute(
        request({
          navigation: { origin: 'https://api.example.test', link: true },
        }),
      ),
      { code: SECURE_HTTP_ERROR_CODE.paginationNavigationInvalid },
    );
    expect(response.close).toHaveBeenCalledOnce();
  });
  it('emits bounded categorical diagnostics without request data', async () => {
    const observations: SecureHttpFailureObservation[] = [];
    const client = new SecureHttpClient(
      new FakeResolver({
        'secret-host.example.test': new Error(
          'resolver exposed secret-token and 192.0.2.9',
        ),
      }),
      new FakeTransport(() => Promise.reject(new Error('must not dispatch'))),
      { observeFailure: (observation) => observations.push(observation) },
    );

    await expectSecureFailure(
      client.execute(
        request({
          headers: { authorization: 'Bearer secret-token' },
          url: 'https://secret-host.example.test/private?token=secret-token',
        }),
      ),
      { code: SECURE_HTTP_ERROR_CODE.dnsFailed, possiblyDispatched: false },
    );

    expect(observations).toEqual([
      expect.objectContaining({
        classification: 'definite_failure',
        possiblyDispatched: false,
        reason: 'dns_failed',
        stage: 'dns',
      }),
    ]);
    expect(JSON.stringify(observations)).not.toContain('secret-token');
    expect(JSON.stringify(observations)).not.toContain('192.0.2.9');
    expect(observations[0]?.durationSeconds).toBeGreaterThanOrEqual(0);
  });
  it.each([
    [SECURE_HTTP_ERROR_CODE.invalidRequest, 'admission'],
    [SECURE_HTTP_ERROR_CODE.ssrfBlocked, 'admission'],
    [SECURE_HTTP_ERROR_CODE.canceled, 'cancellation'],
    [SECURE_HTTP_ERROR_CODE.timedOut, 'cancellation'],
    [SECURE_HTTP_ERROR_CODE.dnsFailed, 'dns'],
    [SECURE_HTTP_ERROR_CODE.connectionFenceFailed, 'pre_dispatch'],
    [SECURE_HTTP_ERROR_CODE.dispatchBindingMismatch, 'pre_dispatch'],
    [SECURE_HTTP_ERROR_CODE.dispatchEvidenceFailed, 'pre_dispatch'],
    [SECURE_HTTP_ERROR_CODE.redirectRejected, 'redirect'],
    [SECURE_HTTP_ERROR_CODE.responseEncodingRejected, 'response'],
    [SECURE_HTTP_ERROR_CODE.responseTooLarge, 'response'],
    [SECURE_HTTP_ERROR_CODE.networkFailed, 'transport'],
  ] as const)('maps diagnostic reason %s to stage %s', async (code, stage) => {
    const observations: SecureHttpFailureObservation[] = [];
    const injected = new SecureHttpError(code, 'definite_failure', {
      possiblyDispatched: false,
    });
    const client = new SecureHttpClient(
      { resolve: () => Promise.reject(injected) },
      new FakeTransport(() => Promise.reject(new Error('must not dispatch'))),
      { observeFailure: (observation) => observations.push(observation) },
    );

    await expect(client.execute(request())).rejects.toBe(injected);
    expect(observations).toEqual([
      expect.objectContaining({ reason: code, stage }),
    ]);
  });
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
        'content-language': ['en', 'de'],
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
        'content-language': 'en, de',
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
          throw consumerFailure;
        }
        return undefined;
      }),
    ).rejects.toBe(consumerFailure);
    expect(failedFixture.close).toHaveBeenCalledOnce();
  });
});
