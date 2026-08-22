import { describe, expect, it, vi } from 'vitest';
import {
  HTTP_REQUEST_DEFINITION,
  HTTP_REQUEST_EXECUTOR,
} from '@pertexo/integrations';
import { createRegistryReleaseSuccessor } from '@pertexo/node-sdk';
import { CORE_SET_DEFINITION, CORE_SET_EXECUTOR } from '@pertexo/nodes-core';

import {
  PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_HTTP_STAGED,
  PLATFORM_REGISTRY_RELEASE_HISTORY,
  PLATFORM_HTTP_ACTIVATION_RELEASE_SUPPORT,
  PLATFORM_HTTP_STAGING_RELEASE_SUPPORT,
  PLATFORM_REGISTRY_RELEASE_SUPPORT,
  platformExecutableRegistryHistory,
  platformRegistryReleaseSupport,
  platformServingRegistryRelease,
} from '../src/registry.js';
import { createPlatformNodeRegistryForRelease } from '../src/server.js';

describe('platform node compatibility catalog', () => {
  it('ships the retained core overlap, staged HTTP introduction, and active successor in order', () => {
    expect(PLATFORM_REGISTRY_RELEASE_HISTORY.map(({ epoch }) => epoch)).toEqual(
      [1, 2, 3, 4],
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
    expect(platformRegistryReleaseSupport('core')).toBe(
      PLATFORM_REGISTRY_RELEASE_SUPPORT,
    );
    expect(platformRegistryReleaseSupport('http_staging')).toBe(
      PLATFORM_HTTP_STAGING_RELEASE_SUPPORT,
    );
    expect(platformRegistryReleaseSupport('http_activation')).toBe(
      PLATFORM_HTTP_ACTIVATION_RELEASE_SUPPORT,
    );
    expect(platformServingRegistryRelease('http_staging').epoch).toBe(2);
    expect(platformServingRegistryRelease('http_activation').epoch).toBe(4);
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
    ).toBe(4);
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
});
