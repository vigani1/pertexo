import { describe, expect, it, vi } from 'vitest';

import {
  createHttpRequestExecutorRegistration,
  SECURE_HTTP_ERROR_CODE,
  SecureHttpClient,
  SecureHttpError,
  type SecureHttpTransportResponse,
} from '../../../src/server.js';
import {
  encoder,
  config,
  runtime,
  invocation,
  response,
  streamingHttpClient,
} from '../../support/http-execution.js';
describe('http.request@1 server executor', () => {
  it('truthfully classifies unsafe ambiguity and pre-dispatch network failure', async () => {
    const ambiguousState = runtime();
    const providerBody = encoder.encode('unavailable');
    const providerFailure = createHttpRequestExecutorRegistration({
      httpClient: streamingHttpClient(async (request) => {
        await request.beforeDispatch();
        return response(providerBody, 503);
      }),
    }).execute(invocation(ambiguousState.value));
    await expect(providerFailure).rejects.toMatchObject({
      decision: { kind: 'outcome_unknown', errorKind: 'provider' },
      possiblyDispatched: true,
    });
    expect(providerBody.every((byte) => byte === 0)).toBe(true);

    const definiteState = runtime();
    const predispatch = createHttpRequestExecutorRegistration({
      httpClient: streamingHttpClient(() =>
        Promise.reject(
          new SecureHttpError(
            SECURE_HTTP_ERROR_CODE.dnsFailed,
            'definite_failure',
            { possiblyDispatched: false },
          ),
        ),
      ),
    }).execute(invocation(definiteState.value));
    await expect(predispatch).rejects.toMatchObject({
      decision: {
        kind: 'retry',
        errorKind: 'network',
        reuseProviderKey: false,
      },
      possiblyDispatched: false,
    });
    expect(definiteState.beforeDispatch).not.toHaveBeenCalled();
    expect(definiteState.secret.every((byte) => byte === 0)).toBe(true);
  });
  it.each([
    {
      failure: 'timeout after provider-confirmed success',
      timeoutMillis: 5,
      stream: {
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
        }),
      },
      decision: { kind: 'outcome_unknown', errorKind: 'timeout' },
    },
    {
      failure: 'network stream failure after provider-confirmed success',
      timeoutMillis: 10_000,
      stream: {
        [Symbol.asyncIterator]: () => ({
          next: () =>
            Promise.reject<IteratorResult<Uint8Array>>(
              new Error('response stream failed'),
            ),
        }),
      },
      decision: { kind: 'outcome_unknown', errorKind: 'network' },
    },
  ])(
    'keeps unsafe inline response $failure',
    async ({ timeoutMillis, stream, decision }) => {
      const providerResponse: SecureHttpTransportResponse = {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: stream,
        close: vi.fn(),
      };
      const httpClient = new SecureHttpClient(
        {
          resolve: () => Promise.resolve([{ address: '8.8.8.8', family: 4 }]),
        },
        { dispatch: () => Promise.resolve(providerResponse) },
      );

      await expect(
        createHttpRequestExecutorRegistration({ httpClient }).execute(
          invocation(runtime().value, {
            config: config({ timeoutMillis }),
          }),
        ),
      ).rejects.toMatchObject({ decision, possiblyDispatched: true });
      expect(providerResponse.close).toHaveBeenCalledOnce();
    },
  );
  it.each(['GET', 'HEAD'])(
    'lets a %s that failed after sending retry, since reading has no side effect',
    async (method) => {
      const unavailable = createHttpRequestExecutorRegistration({
        httpClient: streamingHttpClient(async (request) => {
          await request.beforeDispatch();
          return response(encoder.encode('unavailable'), 503);
        }),
      }).execute(
        invocation(runtime().value, { config: config({ method }), input: {} }),
      );
      await expect(unavailable).rejects.toMatchObject({
        decision: { kind: 'retry', errorKind: 'provider' },
        possiblyDispatched: false,
      });
      const timedOut = createHttpRequestExecutorRegistration({
        httpClient: streamingHttpClient(async (request) => {
          await request.beforeDispatch();
          throw new SecureHttpError(
            SECURE_HTTP_ERROR_CODE.timedOut,
            'ambiguous',
            { possiblyDispatched: true },
          );
        }),
      }).execute(
        invocation(runtime().value, { config: config({ method }), input: {} }),
      );
      await expect(timedOut).rejects.toMatchObject({
        decision: { kind: 'retry', errorKind: 'timeout' },
        possiblyDispatched: false,
      });
      const missing = createHttpRequestExecutorRegistration({
        httpClient: streamingHttpClient(async (request) => {
          await request.beforeDispatch();
          return response(encoder.encode('gone'), 404);
        }),
      }).execute(
        invocation(runtime().value, { config: config({ method }), input: {} }),
      );
      await expect(missing).rejects.toMatchObject({
        decision: { kind: 'failed', errorKind: 'provider' },
        possiblyDispatched: false,
      });
    },
  );
  it.each([
    ['GET', 404, '{"error":"not found"}'],
    ['POST', 500, '{"error":"down"}'],
    ['POST', 429, 'slow down'],
  ] as const)(
    'returns a %s answered %i as output when asked to',
    async (method, status, text) => {
      const answered = await createHttpRequestExecutorRegistration({
        httpClient: streamingHttpClient(async (request) => {
          await request.beforeDispatch();
          return response(encoder.encode(text), status);
        }),
      }).execute(
        invocation(runtime().value, {
          config: config({ method, returnErrorResponses: true }),
          input: {},
        }),
      );
      expect(answered).toMatchObject({
        status,
        body: { kind: 'inline', value: text },
      });
    },
  );
  it('still fails a 2xx-only step on an error status', async () => {
    await expect(
      createHttpRequestExecutorRegistration({
        httpClient: streamingHttpClient(async (request) => {
          await request.beforeDispatch();
          return response(encoder.encode('gone'), 404);
        }),
      }).execute(
        invocation(runtime().value, {
          config: config({ method: 'GET', returnErrorResponses: false }),
          input: {},
        }),
      ),
    ).rejects.toMatchObject({
      decision: { kind: 'failed', errorKind: 'provider' },
    });
  });
});
