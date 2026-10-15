import { describe, expect, it, vi } from 'vitest';
import type { NodeExecutionRuntime } from '@pertexo/node-sdk/server';
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
    connections: { resolve, assertCurrent: () => Promise.resolve() },
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
      let ownedBody: Uint8Array | undefined;
      const client = new SecureHttpClient(
        { resolve: () => Promise.resolve([{ address: '8.8.8.8', family: 4 }]) },
        {
          dispatch: (request) => {
            ownedBody = request.body;
            expect(Buffer.from(request.body ?? []).toString('utf8')).toContain(
              'hello',
            );
            if (failure === 'network loss')
              return Promise.reject(
                new SecureHttpError(
                  SECURE_HTTP_ERROR_CODE.networkFailed,
                  'ambiguous',
                  true,
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
      expect(ownedBody?.every((byte) => byte === 0)).toBe(true);
      expect(state.secret.every((byte) => byte === 0)).toBe(true);
    },
  );
});
