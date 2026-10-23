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
  it('normalizes array-valued content encoding before admitting a response', async () => {
    const resolver = new FakeResolver({
      'api.example.test': [{ address: '8.8.8.8', family: 4 }],
    });
    const identity = transportResponse(200, {
      'content-type': 'text/plain',
      'content-encoding': ['identity'],
    });
    await expect(
      new SecureHttpClient(
        resolver,
        new FakeTransport(() => Promise.resolve(identity.response)),
      ).execute(request()),
    ).resolves.toMatchObject({ bodyEncoding: 'utf8' });
    expect(identity.close).toHaveBeenCalledOnce();

    const unsupported = transportResponse(200, {
      'content-type': 'text/plain',
      'content-encoding': ['gzip'],
    });
    await expectSecureFailure(
      new SecureHttpClient(
        resolver,
        new FakeTransport(() => Promise.resolve(unsupported.response)),
      ).execute(request()),
      {
        code: SECURE_HTTP_ERROR_CODE.responseEncodingRejected,
        classification: 'definite_failure',
        possiblyDispatched: true,
      },
    );
    expect(unsupported.close).toHaveBeenCalledOnce();
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
  it.each([
    { bytes: 65_536, sensitiveValues: ['a'.repeat(1_023) + 'b'] },
    {
      bytes: 262_144,
      sensitiveValues: Array.from(
        { length: 32 },
        (_, index) => 'a'.repeat(8_190) + String(index).padStart(2, '0'),
      ),
    },
  ])(
    'honors the deadline while redacting a buffered near-match response: $bytes bytes',
    async ({ bytes, sensitiveValues }) => {
      const resolver = new FakeResolver({
        'api.example.test': [{ address: '8.8.8.8', family: 4 }],
      });
      const fixture = transportResponse(200, {}, ['a'.repeat(bytes)]);
      const startedAt = performance.now();
      await expectSecureFailure(
        new SecureHttpClient(
          resolver,
          new FakeTransport(() => Promise.resolve(fixture.response)),
        ).execute(
          request({
            timeoutMillis: 5,
            maxResponseBytes: bytes,
            sensitiveValues,
          }),
        ),
        {
          code: SECURE_HTTP_ERROR_CODE.timedOut,
          possiblyDispatched: true,
          classification: 'ambiguous',
        },
      );
      expect(performance.now() - startedAt).toBeLessThan(500);
      expect(fixture.close).toHaveBeenCalledOnce();
    },
  );
  it('lets caller cancellation interrupt CPU-bound redaction and clears the transport chunk', async () => {
    const controller = new AbortController();
    const resolver = new FakeResolver({
      'api.example.test': [{ address: '8.8.8.8', family: 4 }],
    });
    const chunk = encoder.encode('a'.repeat(65_536));
    const close = vi.fn();
    const transport = new FakeTransport(() =>
      Promise.resolve({
        status: 200,
        headers: {},
        close,
        body: {
          async *[Symbol.asyncIterator]() {
            setTimeout(() => {
              controller.abort();
            }, 1);
            await Promise.resolve();
            yield chunk;
          },
        },
      }),
    );
    await expectSecureFailure(
      new SecureHttpClient(resolver, transport)
        .execute(
          request({
            signal: controller.signal,
            maxResponseBytes: 65_536,
            sensitiveValues: ['a'.repeat(8_191) + 'b'],
          }),
        )
        .then(() => 'unexpected successful response'),
      { code: SECURE_HTTP_ERROR_CODE.canceled, possiblyDispatched: true },
    );
    expect(chunk.every((byte) => byte === 0)).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });
  it('clears a transport chunk when cancellation wins before redaction starts', async () => {
    const controller = new AbortController();
    const resolver = new FakeResolver({
      'api.example.test': [{ address: '8.8.8.8', family: 4 }],
    });
    const chunk = encoder.encode('provider-secret');
    const close = vi.fn();
    const transport = new FakeTransport(() =>
      Promise.resolve({
        status: 200,
        headers: {},
        close,
        body: {
          async *[Symbol.asyncIterator]() {
            await Promise.resolve();
            yield chunk;
          },
        },
      }),
    );
    const reason = new Error('cancel before the first streamed chunk');

    await expectSecureFailure(
      new SecureHttpClient(resolver, transport).executeStreaming(
        request({ signal: controller.signal }),
        async (stream) => {
          controller.abort(reason);
          for await (const _chunk of stream.body) {
            // Drain the body; the chunks are not needed.
          }
          return undefined;
        },
      ),
      { code: SECURE_HTTP_ERROR_CODE.canceled, possiblyDispatched: true },
    );
    await vi.waitFor(() => {
      expect(chunk.every((byte) => byte === 0)).toBe(true);
    });
    expect(close).toHaveBeenCalledOnce();
  });
  it('chooses the longest overlapping secret across chunk boundaries', async () => {
    const resolver = new FakeResolver({
      'api.example.test': [{ address: '8.8.8.8', family: 4 }],
    });
    const fixture = transportResponse(200, {}, ['ab', 'c']);
    const response = await new SecureHttpClient(
      resolver,
      new FakeTransport(() => Promise.resolve(fixture.response)),
    ).execute(request({ sensitiveValues: ['ab', 'abc'] }));
    expect(decoder.decode(response.body)).toBe('[Redacted]');
  });
});
