import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  SECURE_HTTP_ERROR_CODE,
  SecureHttpClient,
  type SecureHttpTransportResponse,
} from '../../../src/server.js';
import {
  encoder,
  execFileAsync,
  packageDirectory,
  FakeResolver,
  FakeTransport,
  request,
  expectSecureFailure,
} from '../../support/http-client.js';
describe('secure HTTP client', () => {
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
  it('classifies a dispatch-marker failure without retaining its details', async () => {
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
  });
  it('classifies a DNS failure without retaining resolver details', async () => {
    const dnsFailure = new SecureHttpClient(
      new FakeResolver({
        'api.example.test': new Error('resolver-host-secret'),
      }),
      new FakeTransport(() =>
        Promise.reject(new Error('transport must not dispatch')),
      ),
    ).execute(request());
    await expectSecureFailure(dnsFailure, {
      code: SECURE_HTTP_ERROR_CODE.dnsFailed,
      possiblyDispatched: false,
    });
  });
  it('classifies a transport failure without retaining its cause', async () => {
    const transport = new FakeTransport(() =>
      Promise.reject(new Error('transport-internal-secret')),
    );
    const networkFailure = new SecureHttpClient(
      new FakeResolver({
        'api.example.test': [{ address: '8.8.8.8', family: 4 }],
      }),
      transport,
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
  });
  it('classifies pre-dispatch caller cancellation without inspecting its reason', async () => {
    const controller = new AbortController();
    controller.abort(new Error('caller-secret'));
    await expectSecureFailure(
      new SecureHttpClient(
        new FakeResolver({
          'api.example.test': [{ address: '8.8.8.8', family: 4 }],
        }),
        new FakeTransport(() =>
          Promise.reject(new Error('transport must not dispatch')),
        ),
      ).execute(request({ signal: controller.signal })),
      {
        code: SECURE_HTTP_ERROR_CODE.canceled,
        possiblyDispatched: false,
      },
    );
  });
  it('classifies a total request timeout after transport dispatch', async () => {
    const hungTransport = new FakeTransport(() => new Promise(() => undefined));
    await expectSecureFailure(
      new SecureHttpClient(
        new FakeResolver({
          'api.example.test': [{ address: '8.8.8.8', family: 4 }],
        }),
        hungTransport,
      ).execute(request({ timeoutMillis: 5 })),
      {
        code: SECURE_HTTP_ERROR_CODE.timedOut,
        classification: 'ambiguous',
        possiblyDispatched: true,
      },
    );
  });
  it.each([
    [Object.assign(new Error('socket timeout secret'), { code: 'ETIMEDOUT' })],
    [
      Object.assign(new Error('request timeout secret'), {
        name: 'TimeoutError',
      }),
    ],
  ])(
    'classifies transport timeout errors as ambiguous timeouts',
    async (error) => {
      const client = new SecureHttpClient(
        new FakeResolver({
          'api.example.test': [{ address: '8.8.8.8', family: 4 }],
        }),
        new FakeTransport(() => Promise.reject(error)),
      );

      await expectSecureFailure(client.execute(request()), {
        code: SECURE_HTTP_ERROR_CODE.timedOut,
        classification: 'ambiguous',
        possiblyDispatched: true,
      });
    },
  );
  it.each([null, 42, 'transport-secret'])(
    'normalizes a primitive transport rejection: %s',
    async (error) => {
      const client = new SecureHttpClient(
        new FakeResolver({
          'api.example.test': [{ address: '8.8.8.8', family: 4 }],
        }),
        // Deliberately model an untrusted transport rejection.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        new FakeTransport(() => Promise.reject(error)),
      );

      await expectSecureFailure(client.execute(request()), {
        code: SECURE_HTTP_ERROR_CODE.networkFailed,
        classification: 'ambiguous',
        possiblyDispatched: true,
      });
    },
  );
  it('settles a hostile rejection in isolation without an unhandled derived promise', async () => {
    await expect(
      execFileAsync(process.execPath, [
        '--import',
        'tsx',
        resolve(
          packageDirectory,
          'test/http/secure-hostile-rejection.fixture.ts',
        ),
      ]),
    ).resolves.toMatchObject({ stderr: '' });
  });
});
