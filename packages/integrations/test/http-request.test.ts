import { createRegistryRelease } from '@pertexo/node-sdk';
import {
  createNodeRegistry,
  DISPATCH_AWARE_EXECUTOR_ABI_VERSION,
  type NodeExecutionInvocation,
  type NodeExecutionRuntime,
  type ResolvedNodeConnection,
} from '@pertexo/node-sdk/server';
import { describe, expect, it, vi } from 'vitest';

import {
  HTTP_REQUEST_CONNECTION_SLOT,
  HTTP_REQUEST_DEFINITION_REGISTRATION,
  HTTP_REQUEST_MANIFEST,
  httpRequestConfigSchema,
  httpRequestInputSchema,
} from '../src/index.js';
import {
  createHttpRequestExecutorRegistration,
  HttpRequestExecutorError,
  SECURE_HTTP_ERROR_CODE,
  SecureHttpError,
  type HttpRequestExecutorDependencies,
  type SecureHttpRequest,
} from '../src/server.js';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const connectionId = '22222222-2222-4222-8222-222222222222';
const secretVersionId = '33333333-3333-4333-8333-333333333333';
const encoder = new TextEncoder();

function config(overrides: Record<string, unknown> = {}) {
  return {
    method: 'POST',
    url: 'https://provider.example.test/v1/items',
    headers: { accept: 'application/json' },
    timeoutMillis: 10_000,
    maxRedirects: 2,
    maxResponseBytes: 1_048_576,
    inlineResponseBytes: 65_536,
    ...overrides,
  };
}

function credentialBytes(): Uint8Array {
  return encoder.encode(
    JSON.stringify({
      schemaVersion: 1,
      type: 'http_headers',
      headers: { authorization: 'Bearer executor-secret' },
    }),
  );
}

function runtime(overrides: Partial<NodeExecutionRuntime> = {}) {
  const secret = credentialBytes();
  const resolved: ResolvedNodeConnection = {
    connectionId,
    providerKey: 'http',
    authType: 'http_headers',
    secretVersionId,
    secret,
  };
  const beforeDispatch = vi.fn(() => Promise.resolve());
  const resolve = vi.fn(() => Promise.resolve(resolved));
  const write = vi.fn(() =>
    Promise.resolve({
      artifactId: '44444444-4444-4444-8444-444444444444',
      byteLength: 70_000,
      mediaType: 'application/octet-stream',
      sha256: 'a'.repeat(64),
    }),
  );
  return {
    value: {
      workspaceId,
      runId: '55555555-5555-4555-8555-555555555555',
      nodeRunId: '66666666-6666-4666-8666-666666666666',
      attemptId: '77777777-7777-4777-8777-777777777777',
      attemptNumber: 1,
      nodeId: 'http-node',
      invocationKey: 'http-node-invocation',
      sideEffectClass: 'unsafe' as const,
      beforeDispatch,
      connections: { resolve },
      artifacts: { write },
      ...overrides,
    } satisfies NodeExecutionRuntime,
    beforeDispatch,
    resolve,
    secret,
    write,
  };
}

function invocation(
  executionRuntime: NodeExecutionRuntime,
  overrides: Partial<NodeExecutionInvocation<unknown, unknown>> = {},
): NodeExecutionInvocation<unknown, unknown> {
  return {
    config: config(),
    input: { body: { encoding: 'utf8', value: '{"ok":true}' } },
    connectionRefs: { [HTTP_REQUEST_CONNECTION_SLOT]: connectionId },
    signal: new AbortController().signal,
    runtime: executionRuntime,
    ...overrides,
  };
}

function response(
  body: Uint8Array,
  status = 201,
): Awaited<
  ReturnType<HttpRequestExecutorDependencies['httpClient']['execute']>
> {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body,
    bodyEncoding: 'utf8',
    finalUrl: 'https://provider.example.test',
    redirectCount: 0,
  };
}

describe('http.request@1 candidate definition', () => {
  it('is browser-safe, exact, conservative, and absent from any release', () => {
    expect(HTTP_REQUEST_MANIFEST).toMatchObject({
      definition: { key: 'http.request', version: 1 },
      executor: { key: 'http.request', version: 1 },
      executorAbi: DISPATCH_AWARE_EXECUTOR_ABI_VERSION,
      retryClass: 'unsafe',
      resourceClass: 'io',
      connectionRequirements: [HTTP_REQUEST_CONNECTION_SLOT],
      credentialRequirements: [HTTP_REQUEST_CONNECTION_SLOT],
    });
    expect(HTTP_REQUEST_MANIFEST.capabilities).toEqual([
      'external_http',
      'artifact_output',
      'side_effect_disclosure',
    ]);
    expect(Object.isFrozen(HTTP_REQUEST_MANIFEST)).toBe(true);
  });

  it('rejects unknown fields, credential-like headers, bad URLs, and limit overflow', () => {
    expect(httpRequestConfigSchema.safeParse(config()).success).toBe(true);
    for (const candidate of [
      config({ authorization: 'secret' }),
      config({ headers: { authorization: 'secret' } }),
      config({ headers: { 'x-api-key': 'secret' } }),
      config({ headers: { host: 'metadata.internal' } }),
      config({ url: 'file:///etc/passwd' }),
      config({ url: 'http://example.test/' }),
      config({ url: 'https://user:secret@example.test/' }),
      config({ url: 'https://example.test/?api_key=secret' }),
      config({ timeoutMillis: 120_001 }),
      config({ maxRedirects: 6 }),
      config({ maxResponseBytes: 10_485_761 }),
      config({ maxResponseBytes: 1_024, inlineResponseBytes: 2_048 }),
    ])
      expect(httpRequestConfigSchema.safeParse(candidate).success).toBe(false);
    expect(
      httpRequestInputSchema.safeParse({ body: undefined, unknown: true })
        .success,
    ).toBe(false);
  });
});

describe('http.request@1 server executor', () => {
  it('resolves credentials just in time, marks before I/O, and returns bounded inline output', async () => {
    const state = runtime();
    let requestBody: Uint8Array | undefined;
    const providerBody = encoder.encode('{"created":true}');
    const httpClient = {
      execute: vi.fn(async (request: SecureHttpRequest) => {
        expect(request.headers).toEqual({
          accept: 'application/json',
          authorization: 'Bearer executor-secret',
        });
        expect(request.sensitiveValues).toEqual(['Bearer executor-secret']);
        requestBody = request.body;
        await request.beforeDispatch();
        expect(state.beforeDispatch).toHaveBeenCalledOnce();
        return response(providerBody);
      }),
    } satisfies HttpRequestExecutorDependencies['httpClient'];
    const registration = createHttpRequestExecutorRegistration({ httpClient });

    await expect(
      registration.execute(invocation(state.value)),
    ).resolves.toMatchObject({
      status: 201,
      body: {
        kind: 'inline',
        encoding: 'utf8',
        value: '{"created":true}',
      },
      finalOrigin: 'https://provider.example.test',
    });
    expect(state.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId,
        expectedProviderKey: 'http',
        expectedAuthType: 'http_headers',
      }),
    );
    expect(state.secret.every((byte) => byte === 0)).toBe(true);
    expect(requestBody?.every((byte) => byte === 0)).toBe(true);
    expect(providerBody.every((byte) => byte === 0)).toBe(true);
  });

  it('writes large output through the artifact capability and returns only its reference', async () => {
    const state = runtime();
    const providerBody = new Uint8Array(70_000).fill(7);
    const httpClient = {
      execute: vi.fn(async (request: SecureHttpRequest) => {
        await request.beforeDispatch();
        return response(providerBody);
      }),
    } satisfies HttpRequestExecutorDependencies['httpClient'];
    const registration = createHttpRequestExecutorRegistration({ httpClient });

    const output = await registration.execute(invocation(state.value));
    expect(output).toMatchObject({
      body: {
        kind: 'artifact',
        artifactId: '44444444-4444-4444-8444-444444444444',
        byteLength: 70_000,
      },
    });
    expect(state.write).toHaveBeenCalledWith(
      expect.objectContaining({
        bytes: providerBody,
        purpose: 'node-output',
      }),
    );
    expect(providerBody.every((byte) => byte === 0)).toBe(true);
  });

  it('truthfully classifies unsafe ambiguity and pre-dispatch network failure', async () => {
    const ambiguousState = runtime();
    const providerBody = encoder.encode('unavailable');
    const providerFailure = createHttpRequestExecutorRegistration({
      httpClient: {
        execute: async (request) => {
          await request.beforeDispatch();
          return response(providerBody, 503);
        },
      },
    }).execute(invocation(ambiguousState.value));
    await expect(providerFailure).rejects.toMatchObject({
      decision: { kind: 'outcome_unknown', errorKind: 'provider' },
      possiblyDispatched: true,
    });
    expect(providerBody.every((byte) => byte === 0)).toBe(true);

    const definiteState = runtime();
    const predispatch = createHttpRequestExecutorRegistration({
      httpClient: {
        execute: () =>
          Promise.reject(
            new SecureHttpError(
              SECURE_HTTP_ERROR_CODE.dnsFailed,
              'definite_failure',
              false,
            ),
          ),
      },
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

  it('fails closed on missing runtime, insecure credential transport, collisions, and invalid bodies', async () => {
    const httpClient = { execute: vi.fn() };
    const registration = createHttpRequestExecutorRegistration({ httpClient });
    const state = runtime();
    const candidateWithRuntime = invocation(state.value);
    const { runtime: _runtime, ...candidateWithoutRuntime } =
      candidateWithRuntime;
    void _runtime;
    for (const candidate of [
      candidateWithoutRuntime,
      invocation(state.value, {
        config: config({ headers: { accept: 'application/json' } }),
        input: { body: { encoding: 'base64', value: 'not-base64' } },
      }),
      invocation(state.value, {
        config: config({ headers: { 'X-Tenant': 'configured' } }),
        runtime: runtime({
          connections: {
            resolve: () =>
              Promise.resolve({
                connectionId,
                providerKey: 'http',
                authType: 'http_headers',
                secretVersionId,
                secret: encoder.encode(
                  JSON.stringify({
                    schemaVersion: 1,
                    type: 'http_headers',
                    headers: { 'x-tenant': 'credential' },
                  }),
                ),
              }),
          },
        }).value,
      }),
    ])
      await expect(registration.execute(candidate)).rejects.toBeInstanceOf(
        HttpRequestExecutorError,
      );
    expect(httpClient.execute).not.toHaveBeenCalled();
  });

  it('collapses unexpected connection, transport, and artifact failures into safe outcomes', async () => {
    const connectionState = runtime({
      connections: {
        resolve: () => Promise.reject(new Error('credential-secret')),
      },
    });
    const neverCalled = { execute: vi.fn() };
    await expect(
      createHttpRequestExecutorRegistration({
        httpClient: neverCalled,
      }).execute(invocation(connectionState.value)),
    ).rejects.toEqual(
      new HttpRequestExecutorError(
        { kind: 'failed', errorKind: 'authentication' },
        false,
      ),
    );
    expect(neverCalled.execute).not.toHaveBeenCalled();

    const transportState = runtime();
    await expect(
      createHttpRequestExecutorRegistration({
        httpClient: {
          execute: async (request: SecureHttpRequest) => {
            await request.beforeDispatch();
            throw new Error('provider-secret');
          },
        },
      }).execute(invocation(transportState.value)),
    ).rejects.toEqual(
      new HttpRequestExecutorError(
        { kind: 'outcome_unknown', errorKind: 'network' },
        true,
      ),
    );

    const artifactState = runtime({
      artifacts: {
        write: () => Promise.reject(new Error('storage-secret')),
      },
    });
    await expect(
      createHttpRequestExecutorRegistration({
        httpClient: {
          execute: async (request: SecureHttpRequest) => {
            await request.beforeDispatch();
            return response(new Uint8Array(70_000));
          },
        },
      }).execute(invocation(artifactState.value)),
    ).rejects.toEqual(
      new HttpRequestExecutorError(
        { kind: 'failed', errorKind: 'internal' },
        true,
      ),
    );
  });

  it('matches an exact ABI 2 registry identity without entering the production release', async () => {
    const state = runtime();
    const httpClient = {
      execute: vi.fn(async (request: SecureHttpRequest) => {
        await request.beforeDispatch();
        return response(encoder.encode('{}'), 200);
      }),
    } satisfies HttpRequestExecutorDependencies['httpClient'];
    const registration = createHttpRequestExecutorRegistration(
      { httpClient },
      'active',
    );
    const release = createRegistryRelease({
      epoch: 99,
      definitions: [HTTP_REQUEST_MANIFEST],
      executors: [
        {
          executor: HTTP_REQUEST_MANIFEST.executor,
          abiVersion: DISPATCH_AWARE_EXECUTOR_ABI_VERSION,
          definitions: [HTTP_REQUEST_MANIFEST.definition],
          lifecycle: 'active',
          policyReferences: HTTP_REQUEST_MANIFEST.policyReferences,
        },
      ],
      policies: HTTP_REQUEST_MANIFEST.policyReferences,
    });
    const registry = createNodeRegistry({
      release,
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
