import { inlineBytes } from '../../support/artifact-runtime.js';
import { validateHeaderValue } from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import {
  SECURE_HTTP_ERROR_CODE,
  SecureHttpClient,
} from '../../../src/server.js';
import {
  encoder,
  FakeResolver,
  FakeTransport,
  transportResponse,
  request,
  expectSecureFailure,
} from '../../support/http-client.js';
describe('secure HTTP client', () => {
  it.each([
    { url: 'file:///etc/passwd' },
    { url: 'https://user:password@api.example.test/' },
    { url: 'https://api.example.test/#secret' },
    { headers: { Host: 'metadata.internal' } },
    { headers: { 'Accept-Encoding': 'gzip' } },
    { headers: { 'X-Test': 'valid\r\nInjected: value' } },
    { method: 'GET' as const, body: encoder.encode('unexpected') },
    { timeoutMillis: 0 },
    { timeoutMillis: 120_001 },
    { timeoutMillis: 1.5 },
    { body: new Uint8Array(1_048_577), method: 'POST' as const },
    { maxRedirects: 6 },
    { maxResponseBytes: 10_485_761 },
    { sensitiveValues: [42 as never] },
    { sensitiveValues: [''] },
    { sensitiveValues: Array.from({ length: 65 }, () => 'secret') },
    {
      headers: Object.fromEntries(
        Array.from({ length: 65 }, (_, index) => [`x-${String(index)}`, 'x']),
      ),
    },
    {
      headers: Object.fromEntries(
        Array.from({ length: 5 }, (_, index) => [
          `x-large-${String(index)}`,
          'x'.repeat(8_192),
        ]),
      ),
    },
    { url: `https://api.example.test/${'x'.repeat(2_100)}` },
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
      const bytes = inlineBytes(transportRequest.body);
      if (bytes !== undefined) observed.push(bytes);
      return Promise.resolve(transportResponse(200).response);
    });
    await new SecureHttpClient(resolver, successfulTransport).execute(
      request({ method: 'POST', body: encoder.encode('secret-body') }),
    );
    expect(observed[0]?.every((byte) => byte === 0)).toBe(true);

    const failedTransport = new FakeTransport((transportRequest) => {
      const bytes = inlineBytes(transportRequest.body);
      if (bytes !== undefined) observed.push(bytes);
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
      'mismatch.example.test': [{ address: '8.8.8.8', family: 6 }],
    });
    const transport = new FakeTransport(() =>
      Promise.reject(new Error('must not dispatch')),
    );
    const client = new SecureHttpClient(resolver, transport);
    for (const url of [
      'http://127.0.0.1/',
      'http://127.1/',
      'http://2130706433/',
      'http://0x7f000001/',
      'http://0177.0.0.1/',
      'http://[::1]/',
      'http://[::ffff:127.0.0.1]/',
      'https://private.example.test/',
      'https://mixed.example.test/',
      'https://mismatch.example.test/',
    ]) {
      await expectSecureFailure(client.execute(request({ url })), {
        code: SECURE_HTTP_ERROR_CODE.ssrfBlocked,
        possiblyDispatched: false,
      });
    }
    expect(transport.requests).toEqual([]);
  });
  it.each(['cafe.de', 'dead.be', 'CAFE.DE', 'cafe.de.', 'example.de'])(
    'resolves the valid DNS hostname %s before applying address policy',
    async (hostname) => {
      const canonicalHostname = hostname.toLowerCase();
      const resolver = new FakeResolver({
        [canonicalHostname]: [{ address: '8.8.8.8', family: 4 }],
      });
      const fixture = transportResponse(204, {}, []);
      const transport = new FakeTransport(() =>
        Promise.resolve(fixture.response),
      );
      await expect(
        new SecureHttpClient(resolver, transport).execute(
          request({ url: `https://${hostname}/health` }),
        ),
      ).resolves.toMatchObject({ status: 204 });
      expect(resolver.calls).toEqual([canonicalHostname]);
      expect(transport.requests[0]?.address).toEqual({
        address: '8.8.8.8',
        family: 4,
      });
    },
  );
  it('dispatches a public literal without consulting DNS', async () => {
    const resolver = new FakeResolver({});
    const fixture = transportResponse(204, {}, []);
    const transport = new FakeTransport(() =>
      Promise.resolve(fixture.response),
    );

    await expect(
      new SecureHttpClient(resolver, transport).execute(
        request({ url: 'https://8.8.8.8/health' }),
      ),
    ).resolves.toMatchObject({ status: 204 });
    expect(resolver.calls).toEqual([]);
    expect(transport.requests[0]?.address).toEqual({
      address: '8.8.8.8',
      family: 4,
    });
  });
  it('re-resolves and pins every redirect hop without inheriting trust', async () => {
    const resolver = new FakeResolver({
      'first.example.test': [{ address: '8.8.8.8', family: 4 }],
      'second.example.test': [{ address: '2606:4700:4700::1111', family: 6 }],
    });
    const first = transportResponse(307, {
      location: ['https://second.example.test/final?redirect-secret=value'],
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
});
