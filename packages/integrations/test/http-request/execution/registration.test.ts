import { createNodeCatalog } from '@pertexo/node-sdk';
import {
  createNodeRegistry,
  DISPATCH_AWARE_EXECUTOR_ABI_VERSION,
  type NodeExecutionRuntime,
  ProviderCredentialInvalidError,
} from '@pertexo/node-sdk/server';
import { describe, expect, it, vi } from 'vitest';
import {
  HTTP_REQUEST_CONNECTION_SLOT,
  HTTP_REQUEST_DEFINITION_REGISTRATION,
  HTTP_REQUEST_MANIFEST,
} from '../../../src/index.js';
import {
  createHttpRequestExecutorRegistration,
  SecureHttpClient,
  type HttpRequestExecutorDependencies,
  type SecureHttpRequest,
} from '../../../src/server.js';
import {
  httpRequestConfigSchema,
  httpRequestInputSchema,
} from '../../../src/http-request/validation.js';
import {
  connectionId,
  encoder,
  config,
  runtime,
  httpConnections,
  invocation,
  response,
  streamingHttpClient,
} from '../../support/http-execution.js';
describe('http.request@1 server executor', () => {
  it.each(['resolve', 'fence'] as const)(
    'preserves an earlier uncertain dispatch across a transient %s outage',
    async (stage) => {
      const state = runtime();
      const executionRuntime: NodeExecutionRuntime = {
        ...state.value,
        providerDispatchUnresolved: true,
        connections: httpConnections({
          assertCurrent:
            stage === 'fence'
              ? () => Promise.reject(new Error('postgres unavailable'))
              : state.assertCurrent,
          resolve:
            stage === 'resolve'
              ? () => Promise.reject(new Error('postgres unavailable'))
              : state.resolve,
        }),
      };

      await expect(
        createHttpRequestExecutorRegistration({
          httpClient: streamingHttpClient(async (request) => {
            await request.beforeDispatch();
            return response(new Uint8Array());
          }),
        }).execute(invocation(executionRuntime)),
      ).rejects.toMatchObject({
        decision: { kind: 'outcome_unknown', errorKind: 'provider' },
        possiblyDispatched: true,
      });
    },
  );
  it.each([
    [
      'transient fence failure',
      new Error('postgres unavailable'),
      { kind: 'retry', errorKind: 'provider' },
    ],
    [
      'fence cancellation',
      new DOMException('stopping', 'AbortError'),
      { kind: 'canceled', errorKind: 'canceled' },
    ],
    [
      'credential rotation',
      new ProviderCredentialInvalidError(),
      { kind: 'failed', errorKind: 'authentication' },
    ],
  ] as const)(
    'preserves %s at the dispatch fence',
    async (_name, error, expected) => {
      const state = runtime();
      const executionRuntime: NodeExecutionRuntime = {
        ...state.value,
        connections: httpConnections({
          resolve: state.resolve,
          assertCurrent: () => Promise.reject(error),
        }),
      };
      const dispatch = vi.fn();
      const registration = createHttpRequestExecutorRegistration({
        httpClient: new SecureHttpClient(
          {
            resolve: () =>
              Promise.resolve([{ address: '8.8.8.8', family: 4 as const }]),
          },
          { dispatch },
        ),
      });

      await expect(
        registration.execute(invocation(executionRuntime)),
      ).rejects.toMatchObject({
        decision: expected,
        possiblyDispatched: false,
      });
      expect(dispatch).not.toHaveBeenCalled();
      expect(state.beforeDispatch).not.toHaveBeenCalled();
      expect(state.secret.every((byte) => byte === 0)).toBe(true);
    },
  );
  it.each([
    ['an unsupported method', { method: 'TRACE' }],
    ['a malformed URL', { url: 'not-a-url' }],
    ['an unknown field', { unknown: true }],
  ])(
    'refuses a config with %s at its definition schema',
    (_name, overrides) => {
      expect(httpRequestConfigSchema.safeParse(config(overrides)).success).toBe(
        false,
      );
    },
  );
  it('refuses an incomplete request body at its definition schema', () => {
    expect(
      httpRequestInputSchema.safeParse({ body: { encoding: 'utf8' } }).success,
    ).toBe(false);
  });
  it.each([
    [
      'input above its bound',
      { input: { body: { encoding: 'utf8', value: 'x'.repeat(1_048_577) } } },
    ],
  ])(
    'normalizes %s admission as a configuration failure',
    async (_name, overrides) => {
      const state = runtime();
      let executeStreamingCalls = 0;
      const httpClient: HttpRequestExecutorDependencies['httpClient'] = {
        executeStreaming: () => {
          executeStreamingCalls += 1;
          return Promise.reject(new Error('unexpected HTTP execution'));
        },
      };
      const registration = createHttpRequestExecutorRegistration({
        httpClient,
      });

      await expect(
        registration.execute(invocation(state.value, overrides)),
      ).rejects.toMatchObject({
        decision: { kind: 'failed', errorKind: 'configuration' },
        possiblyDispatched: false,
      });
      expect(state.resolve).not.toHaveBeenCalled();
      expect(executeStreamingCalls).toBe(0);
    },
  );
  it('matches an exact ABI 2 registry identity outside the platform catalog', async () => {
    const state = runtime();
    const httpClient = streamingHttpClient(
      vi.fn(async (request: SecureHttpRequest) => {
        await request.beforeDispatch();
        return response(encoder.encode('{}'), 200);
      }),
    );
    const registration = createHttpRequestExecutorRegistration({ httpClient });
    const catalog = createNodeCatalog({
      definitions: [HTTP_REQUEST_MANIFEST],
      executors: [
        {
          executor: HTTP_REQUEST_MANIFEST.executor,
          abiVersion: DISPATCH_AWARE_EXECUTOR_ABI_VERSION,
          definitions: [HTTP_REQUEST_MANIFEST.definition],
          policyReferences: HTTP_REQUEST_MANIFEST.policyReferences,
        },
      ],
      policies: HTTP_REQUEST_MANIFEST.policyReferences,
    });
    const registry = createNodeRegistry({
      catalog,
      definitions: [HTTP_REQUEST_DEFINITION_REGISTRATION],
      executors: [registration],
    });
    expect(registry.dispatchMode(HTTP_REQUEST_MANIFEST)).toBe(
      'executor_controlled',
    );
    await expect(
      registry.execute({
        definition: HTTP_REQUEST_MANIFEST.definition,
        executor: HTTP_REQUEST_MANIFEST.executor,
        config: config({ method: 'GET' }),
        input: {},
        connectionRefs: { [HTTP_REQUEST_CONNECTION_SLOT]: connectionId },
        signal: new AbortController().signal,
        runtime: state.value,
      }),
    ).resolves.toMatchObject({
      kind: 'succeeded',
      output: { status: 200 },
    });
    expect(state.beforeDispatch).toHaveBeenCalledOnce();
  });
});
