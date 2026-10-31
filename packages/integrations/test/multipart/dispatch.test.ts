import { httpConnections } from '../support/http-execution.js';
import {
  emptyArtifactRuntime,
  spoolBytes,
  sourceBytes,
} from '../support/artifact-runtime.js';
import {
  NodeExecutorFailure,
  type NodeVerifiedByteSource,
} from '@pertexo/node-sdk/server';
import { describe, expect, it, vi } from 'vitest';
import { createNodeCatalog } from '@pertexo/node-sdk';
import {
  createNodeRegistry,
  DISPATCH_AWARE_EXECUTOR_ABI_VERSION,
  type NodeExecutionRuntime,
} from '@pertexo/node-sdk/server';
import {
  HTTP_REQUEST_MANIFEST,
  HTTP_REQUEST_DEFINITION_REGISTRATION,
} from '../../src/index.js';
import {
  createHttpRequestExecutorRegistration,
  SecureHttpClient,
  SecureHttpError,
  SECURE_HTTP_ERROR_CODE,
} from '../../src/server.js';
const key = 'part_11111111-1111-4111-8111-111111111111';
const connectionId = '22222222-2222-4222-8222-222222222222';
function fixture(
  headers: Readonly<Record<string, string>>,
  priorUnknown = false,
) {
  const secret = new TextEncoder().encode(
    JSON.stringify({ type: 'http_headers', headers }),
  );
  const beforeDispatch = vi.fn(() => Promise.resolve());
  const resolve = vi.fn(() =>
    Promise.resolve({
      connectionId,
      providerKey: 'http',
      authType: 'http_headers',
      secretVersionId: '33333333-3333-4333-8333-333333333333',
      secret,
    }),
  );
  const runtime: NodeExecutionRuntime = {
    artifacts: emptyArtifactRuntime,
    workspaceId: 'workspace',
    runId: 'run',
    nodeRunId: 'node-run',
    attemptId: 'attempt',
    attemptNumber: 1,
    nodeId: 'http',
    invocationKey: 'root',
    sideEffectClass: 'unsafe',
    beforeDispatch,
    ...(priorUnknown ? { providerDispatchUnresolved: true } : {}),
    connections: httpConnections({
      resolve,
      assertCurrent: () => Promise.resolve(),
    }),
  };
  const executeStreaming = vi
    .fn()
    .mockRejectedValue(new Error('Transport must not run'));
  const executor = createHttpRequestExecutorRegistration({
    httpClient: { executeStreaming },
  });
  const config = {
    method: 'POST',
    url: 'https://example.test/upload',
    headers: {},
    timeoutMillis: 1000,
    maxRedirects: 0,
    maxResponseBytes: 1024,
    inlineResponseBytes: 1024,
    multipart: { parts: [{ inputKey: key, name: 'message', kind: 'text' }] },
  };
  const execute = (
    overrides: Partial<Parameters<typeof executor.execute>[0]> = {},
  ) =>
    executor.execute({
      config,
      input: { [key]: 'hello' },
      connectionRefs: { http_headers: connectionId },
      runtime,
      signal: new AbortController().signal,
      ...overrides,
    });
  return {
    execute,
    registration: executor,
    config,
    runtime,
    resolve,
    beforeDispatch,
    executeStreaming,
    secret,
  };
}
describe('multipart before-dispatch policy', () => {
  it('refuses a credential Content-Type with a clear diagnostic before dispatch and releases the secret', async () => {
    const state = fixture({
      authorization: 'Bearer owned',
      'content-type': 'application/json',
    });
    await expect(state.execute()).rejects.toMatchObject({
      kind: 'failed',
      errorKind: 'configuration',
      possiblyDispatched: false,
      diagnostic: { reason: 'multipart_content_type' },
    });
    expect(state.beforeDispatch).not.toHaveBeenCalled();
    expect(state.executeStreaming).not.toHaveBeenCalled();
    expect(state.secret.every((value) => value === 0)).toBe(true);
  });
  it('keeps an earlier unresolved dispatch unknown if a later credential conflicts with the multipart header', async () => {
    const state = fixture(
      { authorization: 'Bearer owned', 'content-type': 'application/json' },
      true,
    );
    await expect(state.execute()).rejects.toMatchObject({
      kind: 'outcome_unknown',
      possiblyDispatched: true,
    });
    expect(state.beforeDispatch).not.toHaveBeenCalled();
    expect(state.executeStreaming).not.toHaveBeenCalled();
    expect(state.secret.every((value) => value === 0)).toBe(true);
  });
  it('refuses mixed raw and multipart values before reading credentials or dispatching', async () => {
    const state = fixture({ authorization: 'Bearer owned' });
    await expect(
      state.execute({
        input: { body: { encoding: 'utf8', value: 'raw' }, [key]: 'hello' },
      }),
    ).rejects.toMatchObject({
      diagnostic: { reason: 'multipart_values' },
      possiblyDispatched: false,
    });
    expect(state.resolve).not.toHaveBeenCalled();
    expect(state.beforeDispatch).not.toHaveBeenCalled();
  });
  it('keeps raw mode strict about leftover reserved part values', async () => {
    const state = fixture({ authorization: 'Bearer owned' });
    const { multipart: _multipart, ...config } = state.config;
    await expect(state.execute({ config })).rejects.toMatchObject({
      diagnostic: { reason: 'multipart_values' },
      possiblyDispatched: false,
    });
    expect(state.resolve).not.toHaveBeenCalled();
    expect(state.executeStreaming).not.toHaveBeenCalled();
  });
});

describe('multipart dispatch outcomes', () => {
  it.each(['5xx', 'network loss'] as const)(
    'keeps %s after dispatch unknown and releases request bytes',
    async (failure) => {
      const state = fixture({ authorization: 'Bearer owned' });
      let ownedBody: NodeVerifiedByteSource | Uint8Array | undefined;
      const client = new SecureHttpClient(
        { resolve: () => Promise.resolve([{ address: '8.8.8.8', family: 4 }]) },
        {
          dispatch: async (request) => {
            ownedBody = request.body;
            if (request.body === undefined) throw new Error('Body missing');
            expect(
              (await sourceBytes(request.body)).toString('utf8'),
            ).toContain('hello');
            if (failure === 'network loss')
              return Promise.reject(
                new SecureHttpError(
                  SECURE_HTTP_ERROR_CODE.networkFailed,
                  'ambiguous',
                  { possiblyDispatched: true },
                ),
              );
            return Promise.resolve({
              status: 503,
              headers: { 'content-type': 'text/plain' },
              body: (async function* () {
                yield await Promise.resolve(
                  new TextEncoder().encode('Unavailable'),
                );
              })(),
              close: () => Promise.resolve(),
            });
          },
        },
      );
      await expect(
        createHttpRequestExecutorRegistration({ httpClient: client }).execute({
          config: state.config,
          input: { [key]: 'hello' },
          connectionRefs: { http_headers: connectionId },
          runtime: state.runtime,
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({
        kind: 'outcome_unknown',
        possiblyDispatched: true,
      });
      expect(state.beforeDispatch).toHaveBeenCalledOnce();
      if (ownedBody === undefined || ownedBody instanceof Uint8Array)
        throw new Error('Expected file body');
      const releasedBody = ownedBody;
      expect(() => releasedBody.open(new AbortController().signal)).toThrow(
        'Released test source',
      );
      expect(state.secret.every((byte) => byte === 0)).toBe(true);
    },
  );
});

describe('multipart size feedback through registry validation', () => {
  it('reports oversized file metadata without reading storage, credentials or dispatching', async () => {
    const state = fixture({ authorization: 'Bearer owned' });
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
      executors: [state.registration],
    });
    const read = vi
      .fn()
      .mockRejectedValue(new Error('Storage must not be read'));
    await expect(
      registry.execute({
        definition: HTTP_REQUEST_MANIFEST.definition,
        executor: HTTP_REQUEST_MANIFEST.executor,
        config: {
          ...state.config,
          multipart: { parts: [{ inputKey: key, name: 'file', kind: 'file' }] },
        },
        input: {
          [key]: {
            kind: 'artifact',
            artifactId: '44444444-4444-4444-8444-444444444444',
            byteLength: 10485761,
            mediaType: 'application/octet-stream',
            sha256: 'a'.repeat(64),
          },
        },
        connectionRefs: { http_headers: connectionId },
        signal: new AbortController().signal,
        runtime: { ...state.runtime, artifacts: { read, write: vi.fn() } },
      }),
    ).rejects.toMatchObject({
      kind: 'failed',
      errorKind: 'configuration',
      possiblyDispatched: false,
      diagnostic: { reason: 'multipart_size' },
    });
    expect(read).not.toHaveBeenCalled();
    expect(state.resolve).not.toHaveBeenCalled();
    expect(state.beforeDispatch).not.toHaveBeenCalled();
    expect(state.executeStreaming).not.toHaveBeenCalled();
  });
});

it('keeps an effectful request unknown if file cleanup fails after a successful dispatch, and still wipes credentials', async () => {
  const state = fixture({ authorization: 'Bearer owned' });
  const client = new SecureHttpClient(
    { resolve: () => Promise.resolve([{ address: '8.8.8.8', family: 4 }]) },
    {
      dispatch: () =>
        Promise.resolve({
          status: 204,
          headers: {},
          body: (async function* () {
            await Promise.resolve();
            yield new Uint8Array();
          })(),
          close: () => undefined,
        }),
    },
  );
  state.executeStreaming.mockImplementation(
    client.executeStreaming.bind(client),
  );
  await expect(
    state.execute({
      runtime: {
        ...state.runtime,
        artifacts: {
          ...emptyArtifactRuntime,
          spool: async (input) => {
            const body = await spoolBytes(input);
            return {
              ...body,
              release: async () => {
                await body.release();
                throw new NodeExecutorFailure({
                  kind: 'retry',
                  errorKind: 'internal',
                  possiblyDispatched: false,
                });
              },
            };
          },
        },
      },
    }),
  ).rejects.toMatchObject({
    kind: 'outcome_unknown',
    possiblyDispatched: true,
  });
  expect(state.beforeDispatch).toHaveBeenCalledOnce();
  expect(state.secret.every((byte) => byte === 0)).toBe(true);
});
