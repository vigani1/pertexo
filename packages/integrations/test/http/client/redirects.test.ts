import { inlineBytes } from '../../support/artifact-runtime.js';

import { describe, expect, it, vi } from 'vitest';

import {
  SECURE_HTTP_ERROR_CODE,
  SecureHttpClient,
} from '../../../src/server.js';
import {
  encoder,
  decoder,
  FakeResolver,
  FakeTransport,
  transportResponse,
  request,
  expectSecureFailure,
} from '../../support/http-client.js';
describe('secure HTTP client', () => {
  it.each([307, 308])(
    'preserves a same-origin POST method and body across a %s redirect',
    async (status) => {
      const resolver = new FakeResolver({
        'api.example.test': [{ address: '8.8.8.8', family: 4 }],
      });
      const redirect = transportResponse(status, { location: '/final' });
      const final = transportResponse(204, {}, []);
      const bodies: string[] = [];
      const transport = new FakeTransport((transportRequest, index) => {
        bodies.push(decoder.decode(inlineBytes(transportRequest.body)));
        return Promise.resolve(
          index === 0 ? redirect.response : final.response,
        );
      });
      const marker = vi.fn().mockResolvedValue(undefined);

      await expect(
        new SecureHttpClient(resolver, transport).execute(
          request({
            method: 'POST',
            body: encoder.encode('request-body'),
            beforeDispatch: marker,
          }),
        ),
      ).resolves.toMatchObject({ status: 204, redirectCount: 1 });
      expect(
        transport.requests.map(({ method, url }) => [method, url.pathname]),
      ).toEqual([
        ['POST', '/v1/resource'],
        ['POST', '/final'],
      ]);
      expect(bodies).toEqual(['request-body', 'request-body']);
      expect(marker).toHaveBeenCalledOnce();
      expect(redirect.close).toHaveBeenCalledOnce();
      expect(final.close).toHaveBeenCalledOnce();
    },
  );
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
  it('preserves dispatch truth when a redirect targets a blocked literal', async () => {
    const resolver = new FakeResolver({
      'first.example.test': [{ address: '8.8.8.8', family: 4 }],
    });
    const redirect = transportResponse(302, {
      location: 'http://127.0.0.1/internal',
    });
    const transport = new FakeTransport(() =>
      Promise.resolve(redirect.response),
    );

    await expectSecureFailure(
      new SecureHttpClient(resolver, transport).execute(
        request({ url: 'http://first.example.test/' }),
      ),
      {
        code: SECURE_HTTP_ERROR_CODE.ssrfBlocked,
        classification: 'definite_failure',
        possiblyDispatched: true,
      },
    );
    expect(resolver.calls).toEqual(['first.example.test']);
    expect(transport.requests).toHaveLength(1);
    expect(redirect.close).toHaveBeenCalledOnce();
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
});
