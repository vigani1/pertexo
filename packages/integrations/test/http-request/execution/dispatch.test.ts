import { describe, expect, it, vi } from 'vitest';
import { HTTP_REQUEST_CONNECTION_SLOT } from '../../../src/index.js';
import {
  createHttpRequestExecutorRegistration,
  HttpRequestExecutorError,
  SECURE_HTTP_ERROR_CODE,
  SecureHttpError,
  type SecureHttpResponse,
  type SecureHttpRequest,
} from '../../../src/server.js';
import {
  connectionId,
  secretVersionId,
  encoder,
  config,
  runtime,
  invocation,
  response,
  streamingHttpClient,
} from '../../support/http-execution.js';
describe('http.request@1 server executor', () => {
  it('classifies rate-limited, timed, and canceled dispatches truthfully under the pinned unsafe class', async () => {
    // A post-dispatch 429 is a definite failure for unsafe work and must
    // never enter automatic retry.
    const rateLimitedState = runtime();
    const rateBody = encoder.encode('limited');
    await expect(
      createHttpRequestExecutorRegistration({
        httpClient: streamingHttpClient(async (request) => {
          await request.beforeDispatch();
          return response(rateBody, 429);
        }),
      }).execute(invocation(rateLimitedState.value)),
    ).rejects.toMatchObject({
      decision: { kind: 'failed', errorKind: 'rate_limit' },
      possiblyDispatched: true,
    });
    expect(rateBody.every((byte) => byte === 0)).toBe(true);

    // A timeout that may have reached the provider is outcome_unknown.
    await expect(
      createHttpRequestExecutorRegistration({
        httpClient: streamingHttpClient(async (request) => {
          await request.beforeDispatch();
          throw new SecureHttpError(
            SECURE_HTTP_ERROR_CODE.timedOut,
            'ambiguous',
            { possiblyDispatched: true },
          );
        }),
      }).execute(invocation(runtime().value)),
    ).rejects.toMatchObject({
      decision: { kind: 'outcome_unknown', errorKind: 'timeout' },
      possiblyDispatched: true,
    });

    // A pre-dispatch timeout sent nothing, so a bounded engine retry is
    // truthful even for unsafe work.
    const predispatchTimeout = runtime();
    await expect(
      createHttpRequestExecutorRegistration({
        httpClient: streamingHttpClient(() =>
          Promise.reject(
            new SecureHttpError(
              SECURE_HTTP_ERROR_CODE.timedOut,
              'definite_failure',
              { possiblyDispatched: false },
            ),
          ),
        ),
      }).execute(invocation(predispatchTimeout.value)),
    ).rejects.toMatchObject({
      decision: {
        kind: 'retry',
        errorKind: 'timeout',
        reuseProviderKey: false,
      },
      possiblyDispatched: false,
    });
    expect(predispatchTimeout.beforeDispatch).not.toHaveBeenCalled();

    // Once dispatched, cancellation cannot disprove an unsafe provider effect.
    await expect(
      createHttpRequestExecutorRegistration({
        httpClient: streamingHttpClient(async (request) => {
          await request.beforeDispatch();
          throw new SecureHttpError(
            SECURE_HTTP_ERROR_CODE.canceled,
            'ambiguous',
            { possiblyDispatched: true },
          );
        }),
      }).execute(invocation(runtime().value)),
    ).rejects.toMatchObject({
      decision: { kind: 'outcome_unknown', errorKind: 'provider' },
      possiblyDispatched: true,
    });
  });
  it.each([
    [
      'missing runtime',
      () => {
        const withRuntime = invocation(runtime().value);
        const { runtime: _runtime, ...withoutRuntime } = withRuntime;
        return withoutRuntime;
      },
    ],
    [
      'safe side-effect policy',
      () => invocation(runtime({ sideEffectClass: 'safe' }).value),
    ],
    [
      'unexpected provider idempotency key',
      () => invocation(runtime({ providerIdempotencyKey: 'unexpected' }).value),
    ],
    [
      'missing final credential fence',
      () => {
        const state = runtime();
        return invocation(
          runtime({ connections: { resolve: state.resolve } }).value,
        );
      },
    ],
    [
      'wrong connection slot',
      () =>
        invocation(runtime().value, {
          connectionRefs: { unexpected: connectionId },
        }),
    ],
    [
      'extra connection slot',
      () =>
        invocation(runtime().value, {
          connectionRefs: {
            [HTTP_REQUEST_CONNECTION_SLOT]: connectionId,
            unexpected: connectionId,
          },
        }),
    ],
    [
      'GET body',
      () =>
        invocation(runtime().value, {
          config: config({ method: 'GET' }),
          input: { body: { encoding: 'utf8', value: 'unexpected' } },
        }),
    ],
    [
      'HEAD body',
      () =>
        invocation(runtime().value, {
          config: config({ method: 'HEAD' }),
          input: { body: { encoding: 'utf8', value: 'unexpected' } },
        }),
    ],
    [
      'malformed base64 body',
      () =>
        invocation(runtime().value, {
          input: { body: { encoding: 'base64', value: 'not-base64' } },
        }),
    ],
    [
      'non-canonical base64 body',
      () =>
        invocation(runtime().value, {
          input: { body: { encoding: 'base64', value: 'Zh==' } },
        }),
    ],
    [
      'oversized base64 body',
      () =>
        invocation(runtime().value, {
          input: {
            body: {
              encoding: 'base64',
              value: Buffer.alloc(1_048_577).toString('base64'),
            },
          },
        }),
    ],
    [
      'configured and credential header collision',
      () =>
        invocation(runtime().value, {
          config: config({ headers: { 'X-Tenant': 'configured' } }),
          runtime: runtime({
            connections: {
              assertCurrent: () => Promise.resolve(),
              resolve: () =>
                Promise.resolve({
                  connectionId,
                  providerKey: 'http',
                  authType: 'http_headers',
                  secretVersionId,
                  secret: encoder.encode(
                    JSON.stringify({
                      type: 'http_headers',
                      headers: { 'x-tenant': 'credential' },
                    }),
                  ),
                }),
            },
          }).value,
        }),
    ],
  ] as const)(
    'rejects %s before HTTP provider dispatch',
    async (_name, createCandidate) => {
      const dispatch =
        vi.fn<(request: SecureHttpRequest) => Promise<SecureHttpResponse>>();
      const registration = createHttpRequestExecutorRegistration({
        httpClient: streamingHttpClient(dispatch),
      });

      await expect(
        registration.execute(createCandidate()),
      ).rejects.toBeInstanceOf(HttpRequestExecutorError);
      expect(dispatch).not.toHaveBeenCalled();
    },
  );
  it.each([
    ['empty header set', {}],
    [
      'too many headers',
      Object.fromEntries(
        Array.from({ length: 33 }, (_, index) => [`x-${String(index)}`, 'x']),
      ),
    ],
    ['case-insensitive duplicate', { Authorization: 'a', authorization: 'b' }],
    ['transport-owned header', { host: 'provider.example.test' }],
    [
      'aggregate bytes above the credential limit',
      { first: 'x'.repeat(8_192), second: 'x'.repeat(8_192) },
    ],
  ])('rejects a resolved credential with %s', async (_name, headers) => {
    const state = runtime({
      connections: {
        assertCurrent: () => Promise.resolve(),
        resolve: () =>
          Promise.resolve({
            connectionId,
            providerKey: 'http',
            authType: 'http_headers',
            secretVersionId,
            secret: encoder.encode(
              JSON.stringify({
                type: 'http_headers',
                headers,
              }),
            ),
          }),
      },
    });
    const executeStreaming = vi.fn();

    await expect(
      createHttpRequestExecutorRegistration({
        httpClient: { executeStreaming },
      }).execute(invocation(state.value)),
    ).rejects.toMatchObject({
      decision: { kind: 'failed', errorKind: 'authentication' },
      possiblyDispatched: false,
    });
    expect(executeStreaming).not.toHaveBeenCalled();
  });
});
