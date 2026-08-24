import { describe, expect, it, vi } from 'vitest';
import {
  HTTP_REQUEST_DEFINITION,
  HTTP_REQUEST_EXECUTOR,
  HTTP_REQUEST_MANIFEST,
} from '@pertexo/integrations';
import type {
  HttpRequestExecutorDependencies,
  SecureHttpBodyConsumer,
  SecureHttpRequest,
  SecureHttpResponse,
} from '@pertexo/integrations/server';
import { createRegistryReleaseSuccessor } from '@pertexo/node-sdk';
import type { NodeExecutionRuntime } from '@pertexo/node-sdk/server';
import {
  CORE_CONDITION_DEFINITION,
  CORE_CONDITION_EXECUTOR,
  CORE_PARALLEL_DEFINITION,
  CORE_PARALLEL_EXECUTOR,
  CORE_SET_DEFINITION,
  CORE_SET_EXECUTOR,
  CORE_SWITCH_DEFINITION,
  CORE_SWITCH_EXECUTOR,
} from '@pertexo/nodes-core';

import {
  PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_HTTP_STAGED,
  PLATFORM_REGISTRY_RELEASE_CONDITION_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_CONDITION_STAGED,
  PLATFORM_REGISTRY_RELEASE_HISTORY,
  PLATFORM_REGISTRY_RELEASE_PARALLEL_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_PARALLEL_STAGED,
  PLATFORM_REGISTRY_RELEASE_SWITCH_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_SWITCH_STAGED,
  PLATFORM_CONDITION_ACTIVATION_RELEASE_SUPPORT,
  PLATFORM_CONDITION_STAGING_RELEASE_SUPPORT,
  PLATFORM_HTTP_ACTIVATION_RELEASE_SUPPORT,
  PLATFORM_HTTP_STAGING_RELEASE_SUPPORT,
  PLATFORM_SWITCH_ACTIVATION_RELEASE_SUPPORT,
  PLATFORM_SWITCH_STAGING_RELEASE_SUPPORT,
  PLATFORM_REGISTRY_RELEASE_SUPPORT,
  platformExecutableRegistryHistory,
  platformRegistryReleaseSupport,
  platformServingReleaseRequiresHttpCapabilities,
  platformServingRegistryRelease,
} from '../src/registry.js';
import {
  createPlatformNodeRegistryForRelease,
  resolvePlatformNodeDefinitionForRelease,
} from '../src/server.js';

describe('platform node compatibility catalog', () => {
  it('executes bounded Parallel declaration only in its additive release', async () => {
    const registry = createPlatformNodeRegistryForRelease(
      PLATFORM_REGISTRY_RELEASE_PARALLEL_ACTIVE,
    );
    await expect(
      registry.execute({
        config: {
          branches: [{ id: 'branch-02' }, { id: 'branch-01' }],
          maxConcurrency: 1,
        },
        definition: CORE_PARALLEL_DEFINITION,
        executor: CORE_PARALLEL_EXECUTOR,
        input: {},
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      kind: 'succeeded',
      output: { branchIds: ['branch-02', 'branch-01'] },
    });
  });

  it('executes ordered Switch cases only in its exact additive release', async () => {
    const registry = createPlatformNodeRegistryForRelease(
      PLATFORM_REGISTRY_RELEASE_SWITCH_ACTIVE,
    );
    const config = {
      cases: [
        { id: 'case-02', equals: 'same' },
        { id: 'case-01', equals: 'same' },
      ],
    };
    await expect(
      registry.execute({
        config,
        definition: CORE_SWITCH_DEFINITION,
        executor: CORE_SWITCH_EXECUTOR,
        input: { value: 'same' },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      kind: 'succeeded',
      output: { selectedPort: 'case-02' },
    });
    await expect(
      registry.execute({
        config,
        definition: CORE_SWITCH_DEFINITION,
        executor: CORE_SWITCH_EXECUTOR,
        input: { value: 'missing' },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      kind: 'succeeded',
      output: { selectedPort: 'default' },
    });
    expect(() =>
      resolvePlatformNodeDefinitionForRelease(
        PLATFORM_REGISTRY_RELEASE_CONDITION_ACTIVE,
        CORE_SWITCH_DEFINITION,
      ),
    ).toThrow(/not implemented/u);
  });

  it('resolves and executes Condition only in its exact additive release', async () => {
    const definition = resolvePlatformNodeDefinitionForRelease(
      PLATFORM_REGISTRY_RELEASE_CONDITION_ACTIVE,
      CORE_CONDITION_DEFINITION,
    );
    expect(definition.manifest).toMatchObject({
      definition: { key: 'core.condition', version: 1 },
      executor: { key: 'core.condition', version: 1 },
      family: 'logic',
      ports: { inputs: ['in'], outputs: ['true', 'false'] },
      resourceClass: 'cpu',
      retryClass: 'safe',
    });
    expect(definition.configSchema.safeParse({}).success).toBe(true);
    expect(definition.configSchema.safeParse({ extra: true }).success).toBe(
      false,
    );
    expect(definition.inputSchema.safeParse({ condition: true }).success).toBe(
      true,
    );
    expect(definition.inputSchema.safeParse({ condition: 1 }).success).toBe(
      false,
    );

    const registry = createPlatformNodeRegistryForRelease(
      PLATFORM_REGISTRY_RELEASE_CONDITION_ACTIVE,
    );
    await expect(
      registry.execute({
        config: {},
        definition: CORE_CONDITION_DEFINITION,
        executor: CORE_CONDITION_EXECUTOR,
        input: { condition: true },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      kind: 'succeeded',
      output: { selectedPort: 'true' },
    });
    await expect(
      registry.execute({
        config: {},
        definition: CORE_CONDITION_DEFINITION,
        executor: CORE_CONDITION_EXECUTOR,
        input: { condition: false },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      kind: 'succeeded',
      output: { selectedPort: 'false' },
    });
    expect(() =>
      resolvePlatformNodeDefinitionForRelease(
        PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
        CORE_CONDITION_DEFINITION,
      ),
    ).toThrow(/not implemented/u);
  });

  it('resolves exact definition schemas without constructing or calling an executor', () => {
    const resolved = resolvePlatformNodeDefinitionForRelease(
      PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
      HTTP_REQUEST_DEFINITION,
    );
    expect(resolved.manifest).toStrictEqual(HTTP_REQUEST_MANIFEST);
    expect(
      resolved.configSchema.safeParse({
        method: 'GET',
        url: 'https://provider.example.test/resource',
        headers: {},
        timeoutMillis: 1_000,
        maxRedirects: 1,
        maxResponseBytes: 1_024,
        inlineResponseBytes: 512,
      }).success,
    ).toBe(true);
    expect(() =>
      resolvePlatformNodeDefinitionForRelease(
        PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
        { key: 'missing.node', version: 1 },
      ),
    ).toThrow(/not implemented/u);
  });
  it('retains every additive release in canonical order', () => {
    expect(PLATFORM_REGISTRY_RELEASE_HISTORY.map(({ epoch }) => epoch)).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    );
    expect(PLATFORM_REGISTRY_RELEASE_SUPPORT.map(({ epoch }) => epoch)).toEqual(
      [1, 2],
    );
    expect(
      PLATFORM_HTTP_STAGING_RELEASE_SUPPORT.map(({ epoch }) => epoch),
    ).toEqual([2, 3]);
    expect(
      PLATFORM_HTTP_ACTIVATION_RELEASE_SUPPORT.map(({ epoch }) => epoch),
    ).toEqual([3, 4]);
    expect(
      PLATFORM_CONDITION_STAGING_RELEASE_SUPPORT.map(({ epoch }) => epoch),
    ).toEqual([4, 5]);
    expect(
      PLATFORM_CONDITION_ACTIVATION_RELEASE_SUPPORT.map(({ epoch }) => epoch),
    ).toEqual([5, 6]);
    expect(
      PLATFORM_SWITCH_STAGING_RELEASE_SUPPORT.map(({ epoch }) => epoch),
    ).toEqual([6, 7]);
    expect(
      PLATFORM_SWITCH_ACTIVATION_RELEASE_SUPPORT.map(({ epoch }) => epoch),
    ).toEqual([7, 8]);
    expect(platformRegistryReleaseSupport('core')).toBe(
      PLATFORM_REGISTRY_RELEASE_SUPPORT,
    );
    expect(platformRegistryReleaseSupport('http_staging')).toBe(
      PLATFORM_HTTP_STAGING_RELEASE_SUPPORT,
    );
    expect(platformRegistryReleaseSupport('http_activation')).toBe(
      PLATFORM_HTTP_ACTIVATION_RELEASE_SUPPORT,
    );
    expect(platformRegistryReleaseSupport('condition_staging')).toBe(
      PLATFORM_CONDITION_STAGING_RELEASE_SUPPORT,
    );
    expect(platformRegistryReleaseSupport('condition_activation')).toBe(
      PLATFORM_CONDITION_ACTIVATION_RELEASE_SUPPORT,
    );
    expect(platformRegistryReleaseSupport('switch_staging')).toBe(
      PLATFORM_SWITCH_STAGING_RELEASE_SUPPORT,
    );
    expect(platformRegistryReleaseSupport('switch_activation')).toBe(
      PLATFORM_SWITCH_ACTIVATION_RELEASE_SUPPORT,
    );
    expect(platformServingRegistryRelease('http_staging').epoch).toBe(2);
    expect(platformServingRegistryRelease('http_activation').epoch).toBe(4);
    expect(platformServingRegistryRelease('condition_staging').epoch).toBe(4);
    expect(platformServingRegistryRelease('condition_activation').epoch).toBe(
      6,
    );
    expect(platformServingRegistryRelease('switch_staging').epoch).toBe(6);
    expect(platformServingRegistryRelease('switch_activation').epoch).toBe(8);
    expect(platformServingReleaseRequiresHttpCapabilities('core')).toBe(false);
    expect(
      platformServingReleaseRequiresHttpCapabilities('condition_staging'),
    ).toBe(true);
    expect(
      platformServingReleaseRequiresHttpCapabilities('condition_activation'),
    ).toBe(true);
    expect(
      platformServingReleaseRequiresHttpCapabilities('switch_activation'),
    ).toBe(true);
    expect(
      platformExecutableRegistryHistory('http_staging').map(
        ({ epoch }) => epoch,
      ),
    ).toEqual([1, 2, 3]);
    expect(
      platformExecutableRegistryHistory('http_activation').map(
        ({ epoch }) => epoch,
      ),
    ).toEqual([1, 2, 3, 4]);
    expect(
      platformExecutableRegistryHistory('condition_activation').map(
        ({ epoch }) => epoch,
      ),
    ).toEqual([1, 2, 3, 4, 5, 6]);
    expect(
      platformExecutableRegistryHistory('switch_activation').map(
        ({ epoch }) => epoch,
      ),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(
      PLATFORM_REGISTRY_RELEASE_HTTP_STAGED.executors.find(
        ({ executor }) => executor.key === HTTP_REQUEST_EXECUTOR.key,
      ),
    ).toMatchObject({ lifecycle: 'staged', abiVersion: 2 });
    expect(
      PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE.executors.find(
        ({ executor }) => executor.key === HTTP_REQUEST_EXECUTOR.key,
      ),
    ).toMatchObject({ lifecycle: 'active', abiVersion: 2 });
    expect(
      PLATFORM_REGISTRY_RELEASE_CONDITION_STAGED.executors.find(
        ({ executor }) => executor.key === CORE_CONDITION_EXECUTOR.key,
      ),
    ).toMatchObject({ lifecycle: 'staged', abiVersion: 1 });
    expect(
      PLATFORM_REGISTRY_RELEASE_CONDITION_ACTIVE.executors.find(
        ({ executor }) => executor.key === CORE_CONDITION_EXECUTOR.key,
      ),
    ).toMatchObject({ lifecycle: 'active', abiVersion: 1 });
    expect(
      PLATFORM_REGISTRY_RELEASE_SWITCH_STAGED.executors.find(
        ({ executor }) => executor.key === CORE_SWITCH_EXECUTOR.key,
      ),
    ).toMatchObject({ lifecycle: 'staged', abiVersion: 1 });
    expect(
      PLATFORM_REGISTRY_RELEASE_SWITCH_ACTIVE.executors.find(
        ({ executor }) => executor.key === CORE_SWITCH_EXECUTOR.key,
      ),
    ).toMatchObject({ lifecycle: 'active', abiVersion: 1 });
    expect(
      PLATFORM_REGISTRY_RELEASE_PARALLEL_STAGED.executors.find(
        ({ executor }) => executor.key === CORE_PARALLEL_EXECUTOR.key,
      ),
    ).toMatchObject({ lifecycle: 'staged', abiVersion: 1 });
    expect(
      PLATFORM_REGISTRY_RELEASE_PARALLEL_ACTIVE.executors.find(
        ({ executor }) => executor.key === CORE_PARALLEL_EXECUTOR.key,
      ),
    ).toMatchObject({ lifecycle: 'active', abiVersion: 1 });
    expect(
      PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE.definitions.map(
        ({ definition }) => definition,
      ),
    ).toEqual(
      expect.arrayContaining([CORE_SET_DEFINITION, HTTP_REQUEST_DEFINITION]),
    );
    expect(
      new Set(
        PLATFORM_REGISTRY_RELEASE_HISTORY.map(({ fingerprint }) => fingerprint),
      ).size,
    ).toBe(10);
  });

  it('builds one exact active server registry with retained core and dispatch-aware HTTP', async () => {
    const registry = createPlatformNodeRegistryForRelease(
      PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
      { httpRequest: { httpClient: { executeStreaming: vi.fn() } as never } },
    );
    expect(registry.compatibility).toEqual({
      epoch: PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE.epoch,
      fingerprint: PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE.fingerprint,
    });
    expect(registry.historicalCatalog().definitions).toEqual(
      expect.arrayContaining([CORE_SET_DEFINITION, HTTP_REQUEST_DEFINITION]),
    );
    expect(
      registry.dispatchMode({
        definition: CORE_SET_DEFINITION,
        executor: CORE_SET_EXECUTOR,
      }),
    ).toBe('before_execute');
    expect(
      registry.dispatchMode({
        definition: HTTP_REQUEST_DEFINITION,
        executor: HTTP_REQUEST_EXECUTOR,
      }),
    ).toBe('executor_controlled');
    await expect(
      registry.execute({
        definition: CORE_SET_DEFINITION,
        executor: CORE_SET_EXECUTOR,
        config: {},
        input: { value: true },
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ kind: 'succeeded' });
  });

  it('rejects a staged execution registry and an unshipped identity', () => {
    expect(() =>
      createPlatformNodeRegistryForRelease(
        PLATFORM_REGISTRY_RELEASE_HTTP_STAGED,
        { httpRequest: { httpClient: { executeStreaming: vi.fn() } as never } },
      ),
    ).toThrow(/cannot execute this release/u);
    const unshipped = createRegistryReleaseSuccessor({
      previous: PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
      epoch: PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE.epoch + 1,
      definitions: PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE.definitions.map(
        (manifest) =>
          manifest.definition.key === HTTP_REQUEST_DEFINITION.key
            ? { ...manifest, lifecycle: 'deprecated' as const }
            : manifest,
      ),
      executors: PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE.executors,
      policies: PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE.policies,
    });
    expect(() => createPlatformNodeRegistryForRelease(unshipped)).toThrow(
      'Platform compatibility release identity is not supported',
    );
  });

  it('threads provider telemetry through the active HTTP registry', async () => {
    const connectionId = '11111111-1111-4111-8111-111111111111';
    const secret = new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: 1,
        type: 'http_headers',
        headers: { authorization: 'Bearer telemetry-proof' },
      }),
    );
    const executeStreaming = async <Body>(
      request: SecureHttpRequest,
      consume: SecureHttpBodyConsumer<Body>,
    ): Promise<SecureHttpResponse<Body>> => {
      await request.beforeDispatch();
      const signal = request.signal ?? new AbortController().signal;
      const body = await consume({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: (async function* (): AsyncGenerator<Uint8Array> {
          await Promise.resolve();
          yield new TextEncoder().encode('{"ok":true}');
        })(),
        bodyEncoding: 'utf8',
        finalUrl: 'https://provider.example.test',
        redirectCount: 0,
        signal,
      });
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body,
        bodyEncoding: 'utf8',
        finalUrl: 'https://provider.example.test',
        redirectCount: 0,
      };
    };
    const measure = vi.fn<
      NonNullable<HttpRequestExecutorDependencies['telemetry']>['measure']
    >((work) => work());
    const beforeDispatch = vi.fn().mockResolvedValue(undefined);
    const runtime = {
      workspaceId: '22222222-2222-4222-8222-222222222222',
      runId: '33333333-3333-4333-8333-333333333333',
      nodeRunId: '44444444-4444-4444-8444-444444444444',
      attemptId: '55555555-5555-4555-8555-555555555555',
      attemptNumber: 1,
      nodeId: 'http',
      invocationKey: 'http-invocation',
      sideEffectClass: 'unsafe',
      beforeDispatch,
      connections: {
        assertCurrent: vi.fn().mockResolvedValue(undefined),
        resolve: vi.fn().mockResolvedValue({
          connectionId,
          providerKey: 'http',
          authType: 'http_headers',
          secretVersionId: '66666666-6666-4666-8666-666666666666',
          secret,
        }),
      },
    } satisfies NodeExecutionRuntime;
    const registry = createPlatformNodeRegistryForRelease(
      PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
      {
        httpRequest: {
          httpClient: { executeStreaming },
        },
        httpRequestTelemetry: { measure },
      },
    );

    await expect(
      registry.execute({
        definition: HTTP_REQUEST_DEFINITION,
        executor: HTTP_REQUEST_EXECUTOR,
        config: {
          method: 'GET',
          url: 'https://provider.example.test/v1/items',
          headers: { accept: 'application/json' },
          timeoutMillis: 10_000,
          maxRedirects: 2,
          maxResponseBytes: 1_048_576,
          inlineResponseBytes: 65_536,
        },
        input: {},
        connectionRefs: { http_headers: connectionId },
        runtime,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      kind: 'succeeded',
      output: { body: { kind: 'inline', value: '{"ok":true}' } },
    });
    expect(measure).toHaveBeenCalledOnce();
    expect(beforeDispatch).toHaveBeenCalledOnce();
    expect(secret.every((byte) => byte === 0)).toBe(true);
  });
});
