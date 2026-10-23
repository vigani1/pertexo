import {
  ProviderCredentialInvalidError,
  ProviderExecutionRateLimitError,
} from '@pertexo/node-sdk/server';
import { describe, expect, it, vi } from 'vitest';

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
  credentialBytes,
  runtime,
  invocation,
  response,
  streamingHttpClient,
} from '../../support/http-execution.js';
describe('http.request@1 server executor', () => {
  it('maps HTTP credential-resolution throttling without provider dispatch', async () => {
    const limitedState = runtime({
      connections: {
        assertCurrent: () => Promise.resolve(),
        resolve: () => Promise.reject(new ProviderExecutionRateLimitError(7)),
      },
    });
    const noLimitedDispatch =
      vi.fn<(request: SecureHttpRequest) => Promise<SecureHttpResponse>>();
    await expect(
      createHttpRequestExecutorRegistration({
        httpClient: streamingHttpClient(noLimitedDispatch),
      }).execute(invocation(limitedState.value)),
    ).rejects.toEqual(
      new HttpRequestExecutorError(
        { kind: 'retry', errorKind: 'rate_limit', reuseProviderKey: false },
        { possiblyDispatched: false },
      ),
    );
    expect(noLimitedDispatch).not.toHaveBeenCalled();
  });
  it('maps a transient HTTP credential-resolution failure without provider dispatch', async () => {
    const connectionState = runtime({
      connections: {
        assertCurrent: () => Promise.resolve(),
        resolve: () => Promise.reject(new Error('credential-secret')),
      },
    });
    const neverCalled =
      vi.fn<(request: SecureHttpRequest) => Promise<SecureHttpResponse>>();
    await expect(
      createHttpRequestExecutorRegistration({
        httpClient: streamingHttpClient(neverCalled),
      }).execute(invocation(connectionState.value)),
    ).rejects.toEqual(
      new HttpRequestExecutorError(
        { kind: 'retry', errorKind: 'provider', reuseProviderKey: false },
        { possiblyDispatched: false },
      ),
    );
    expect(neverCalled).not.toHaveBeenCalled();
  });
  it('maps an unexpected post-dispatch HTTP transport failure to unknown', async () => {
    const transportState = runtime();
    await expect(
      createHttpRequestExecutorRegistration({
        httpClient: streamingHttpClient(async (request: SecureHttpRequest) => {
          await request.beforeDispatch();
          throw new Error('provider-secret');
        }),
      }).execute(invocation(transportState.value)),
    ).rejects.toEqual(
      new HttpRequestExecutorError(
        { kind: 'outcome_unknown', errorKind: 'network' },
        { possiblyDispatched: true },
      ),
    );
  });
  it('rejects a mismatched resolved HTTP connection identity', async () => {
    const neverCalled =
      vi.fn<(request: SecureHttpRequest) => Promise<SecureHttpResponse>>();
    const mismatchedConnection = runtime({
      connections: {
        assertCurrent: () => Promise.resolve(),
        resolve: () =>
          Promise.resolve({
            connectionId,
            providerKey: 'email',
            authType: 'http_headers',
            secretVersionId,
            secret: credentialBytes(),
          }),
      },
    });
    await expect(
      createHttpRequestExecutorRegistration({
        httpClient: streamingHttpClient(neverCalled),
      }).execute(invocation(mismatchedConnection.value)),
    ).rejects.toMatchObject({
      decision: { kind: 'failed', errorKind: 'configuration' },
      possiblyDispatched: false,
    });
    expect(neverCalled).not.toHaveBeenCalled();
  });
  it('maps an HTTP dispatch-binding mismatch to configuration failure', async () => {
    await expect(
      createHttpRequestExecutorRegistration({
        httpClient: streamingHttpClient(() =>
          Promise.reject(
            new SecureHttpError(
              SECURE_HTTP_ERROR_CODE.dispatchBindingMismatch,
              'definite_failure',
              { possiblyDispatched: false },
            ),
          ),
        ),
      }).execute(invocation(runtime().value)),
    ).rejects.toMatchObject({
      decision: { kind: 'failed', errorKind: 'configuration' },
      possiblyDispatched: false,
    });
  });
  it('maps artifact persistence failure after provider response to unknown', async () => {
    const artifactState = runtime({
      artifacts: {
        write: () => Promise.reject(new Error('storage-secret')),
      },
    });
    await expect(
      createHttpRequestExecutorRegistration({
        httpClient: streamingHttpClient(async (request: SecureHttpRequest) => {
          await request.beforeDispatch();
          return response(new Uint8Array(70_000));
        }),
      }).execute(invocation(artifactState.value)),
    ).rejects.toMatchObject({
      decision: { kind: 'outcome_unknown', errorKind: 'provider' },
      possiblyDispatched: true,
    });
  });
  it('fails closed when a large HTTP response has no artifact capability', async () => {
    const noArtifactState = runtime();
    const { artifacts: _artifacts, ...runtimeWithoutArtifacts } =
      noArtifactState.value;
    await expect(
      createHttpRequestExecutorRegistration({
        httpClient: streamingHttpClient(async (request: SecureHttpRequest) => {
          await request.beforeDispatch();
          return response(new Uint8Array(70_000));
        }),
      }).execute(invocation(runtimeWithoutArtifacts)),
    ).rejects.toEqual(
      new HttpRequestExecutorError(
        { kind: 'outcome_unknown', errorKind: 'provider' },
        { possiblyDispatched: true },
      ),
    );
  });
  it('uses the binary default media type for an untyped large response', async () => {
    const defaultMediaType = runtime();
    await createHttpRequestExecutorRegistration({
      httpClient: streamingHttpClient(async (request: SecureHttpRequest) => {
        await request.beforeDispatch();
        return {
          ...response(new Uint8Array(70_000)),
          headers: {},
        };
      }),
    }).execute(invocation(defaultMediaType.value));
    expect(defaultMediaType.write).toHaveBeenCalledWith(
      expect.objectContaining({ mediaType: 'application/octet-stream' }),
    );
  });
  it('maps a hostile HTTP adapter rejection without leaking or re-inspecting it', async () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error('adapter-prototype-trap');
        },
      },
    );
    const state = runtime();

    await expect(
      createHttpRequestExecutorRegistration({
        httpClient: {
          executeStreaming: async (request) => {
            await request.beforeDispatch();
            // Deliberately model an untrusted adapter rejection.
            // eslint-disable-next-line @typescript-eslint/only-throw-error
            throw hostile;
          },
        },
      }).execute(invocation(state.value)),
    ).rejects.toMatchObject({
      decision: { kind: 'outcome_unknown', errorKind: 'network' },
      possiblyDispatched: true,
    });
  });
  it.each([
    [
      'transient resolution failure',
      new Error('postgres unavailable'),
      { kind: 'retry', errorKind: 'provider' },
    ],
    [
      'resolution cancellation',
      new DOMException('stopping', 'AbortError'),
      { kind: 'canceled', errorKind: 'canceled' },
    ],
    [
      'invalid credential',
      new ProviderCredentialInvalidError(),
      { kind: 'failed', errorKind: 'authentication' },
    ],
  ] as const)(
    'preserves %s before provider dispatch',
    async (_name, error, expected) => {
      const state = runtime({
        connections: {
          assertCurrent: () => Promise.resolve(),
          resolve: () => Promise.reject(error),
        },
      });
      const executeStreaming = vi.fn();

      await expect(
        createHttpRequestExecutorRegistration({
          httpClient: { executeStreaming },
        }).execute(invocation(state.value)),
      ).rejects.toMatchObject({
        decision: expected,
        possiblyDispatched: false,
      });
      expect(executeStreaming).not.toHaveBeenCalled();
    },
  );
});
