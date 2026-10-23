import { describe, expect, it, vi } from 'vitest';

import {
  SECURE_HTTP_ERROR_CODE,
  SecureHttpClient,
  type SecureHttpTransportResponse,
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
  it.each([
    {
      name: 'revoked proxy',
      create: () => {
        const { proxy, revoke } = Proxy.revocable({}, {});
        revoke();
        return proxy;
      },
    },
    {
      name: 'throwing prototype trap',
      create: () =>
        new Proxy(
          {},
          {
            getPrototypeOf: () => {
              throw new Error('prototype-trap');
            },
          },
        ),
    },
    {
      name: 'throwing timeout properties',
      create: () =>
        Object.defineProperties(Object.create(Error.prototype), {
          code: {
            get: () => {
              throw new Error('code-trap');
            },
          },
          name: {
            get: () => {
              throw new Error('name-trap');
            },
          },
        }) as unknown,
    },
  ])(
    'settles once for a hostile transport rejection: $name',
    async ({ create }) => {
      const client = new SecureHttpClient(
        new FakeResolver({
          'api.example.test': [{ address: '8.8.8.8', family: 4 }],
        }),
        new FakeTransport(() => {
          // Deliberately model an untrusted transport rejection.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          return Promise.reject(create());
        }),
      );

      await expectSecureFailure(client.execute(request()), {
        code: SECURE_HTTP_ERROR_CODE.networkFailed,
        classification: 'ambiguous',
        possiblyDispatched: true,
      });
    },
  );
  it('classifies a hostile abort reason without inspecting it unsafely', async () => {
    const controller = new AbortController();
    const reason = Object.defineProperty({}, 'name', {
      get: () => {
        throw new Error('abort-name-trap');
      },
    });
    controller.abort(reason);
    const transport = new FakeTransport(() =>
      Promise.reject(new Error('must not dispatch')),
    );

    await expectSecureFailure(
      new SecureHttpClient(
        new FakeResolver({
          'api.example.test': [{ address: '8.8.8.8', family: 4 }],
        }),
        transport,
      ).execute(request({ signal: controller.signal })),
      {
        code: SECURE_HTTP_ERROR_CODE.canceled,
        classification: 'definite_failure',
        possiblyDispatched: false,
      },
    );
    expect(transport.requests).toHaveLength(0);
  });
  it('observes a transport rejection after synchronous abort and settles cancellation once', async () => {
    const controller = new AbortController();
    let rejectLate: ((reason: unknown) => void) | undefined;
    const lateWork = new Promise<SecureHttpTransportResponse>(
      (_resolve, reject) => {
        rejectLate = reject;
      },
    );
    const transport = new FakeTransport(() => {
      controller.abort(new Error('synchronous adapter abort'));
      return lateWork;
    });
    const execution = new SecureHttpClient(
      new FakeResolver({
        'api.example.test': [{ address: '8.8.8.8', family: 4 }],
      }),
      transport,
    ).execute(request({ signal: controller.signal }));

    await expectSecureFailure(execution, {
      code: SECURE_HTTP_ERROR_CODE.canceled,
      classification: 'ambiguous',
      possiblyDispatched: true,
    });
    // This rejection is delivered to the handler installed before the
    // synchronous abort was observed.
    rejectLate?.(
      new Proxy(
        {},
        {
          getPrototypeOf: () => {
            throw new Error('late-prototype-trap');
          },
        },
      ),
    );
    await Promise.resolve();
    expect(transport.requests).toHaveLength(1);
  });
  it('closes a transport response that fulfills after cancellation', async () => {
    const controller = new AbortController();
    let resolveLate:
      ((response: SecureHttpTransportResponse) => void) | undefined;
    const lateWork = new Promise<SecureHttpTransportResponse>((resolve) => {
      resolveLate = resolve;
    });
    const transport = new FakeTransport(() => lateWork);
    const execution = new SecureHttpClient(
      new FakeResolver({
        'api.example.test': [{ address: '8.8.8.8', family: 4 }],
      }),
      transport,
    ).execute(request({ signal: controller.signal }));
    await vi.waitFor(() => {
      expect(transport.requests).toHaveLength(1);
    });
    controller.abort();
    await expectSecureFailure(execution, {
      code: SECURE_HTTP_ERROR_CODE.canceled,
      possiblyDispatched: true,
    });

    const late = transportResponse(200);
    resolveLate?.(late.response);
    await vi.waitFor(() => {
      expect(late.close).toHaveBeenCalledOnce();
    });
  });
  it('closes exactly once when fulfillment and abort occur in adjacent microtasks', async () => {
    const controller = new AbortController();
    const fixture = transportResponse(200);
    const transport = new FakeTransport(
      () =>
        new Promise((resolve) => {
          queueMicrotask(() => {
            resolve(fixture.response);
          });
          queueMicrotask(() => {
            controller.abort();
          });
        }),
    );

    await expectSecureFailure(
      new SecureHttpClient(
        new FakeResolver({
          'api.example.test': [{ address: '8.8.8.8', family: 4 }],
        }),
        transport,
      ).execute(request({ signal: controller.signal })),
      {
        code: SECURE_HTTP_ERROR_CODE.canceled,
        possiblyDispatched: true,
      },
    );
    await vi.waitFor(() => {
      expect(fixture.close).toHaveBeenCalledOnce();
    });
  });
  it('does not dispose a successful response before body ownership completes', async () => {
    const fixture = transportResponse(200, {}, ['body']);
    let closedWhileConsuming = false;
    const response = await new SecureHttpClient(
      new FakeResolver({
        'api.example.test': [{ address: '8.8.8.8', family: 4 }],
      }),
      new FakeTransport(() => Promise.resolve(fixture.response)),
    ).executeStreaming(request(), async (stream) => {
      closedWhileConsuming = fixture.close.mock.calls.length > 0;
      const chunks: Uint8Array[] = [];
      for await (const chunk of stream.body) chunks.push(chunk);
      return decoder.decode(Buffer.concat(chunks));
    });

    expect(response.body).toBe('body');
    expect(closedWhileConsuming).toBe(false);
    expect(fixture.close).toHaveBeenCalledOnce();
  });
  it('lets cancellation win after transport dispatch has started', async () => {
    const controller = new AbortController();
    let dispatchStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      dispatchStarted = resolve;
    });
    const transport = new FakeTransport(() => {
      dispatchStarted?.();
      return new Promise(() => undefined);
    });
    const execution = new SecureHttpClient(
      new FakeResolver({
        'api.example.test': [{ address: '8.8.8.8', family: 4 }],
      }),
      transport,
    ).execute(request({ signal: controller.signal }));
    await started;
    controller.abort(new Error('caller-secret'));

    await expectSecureFailure(execution, {
      code: SECURE_HTTP_ERROR_CODE.canceled,
      classification: 'ambiguous',
      possiblyDispatched: true,
    });
    expect(transport.requests).toHaveLength(1);
  });
});
