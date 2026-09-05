import { describe, expect, it } from 'vitest';
import { createRegistryReleaseSuccessor } from '@pertexo/node-sdk';

import {
  CORE_BOUNDED_JSON_POLICY,
  CORE_DEFINITION_MANIFESTS,
  CORE_MANUAL_DEFINITION,
  CORE_MANUAL_EXECUTOR,
  CORE_NODE_DEFINITION_REGISTRATIONS,
  CORE_REGISTRY_RELEASE,
} from '../src/index.js';
import {
  CORE_NODE_EXECUTOR_REGISTRATIONS,
  createCoreNodeRegistry,
  createCoreNodeRegistryForRelease,
} from '../src/server.js';

function expectRecursivelyFrozen(
  value: unknown,
  visited = new Set<object>(),
): void {
  if (value === null || typeof value !== 'object' || visited.has(value)) return;
  visited.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const nested of Object.values(value))
    expectRecursivelyFrozen(nested, visited);
}

describe('core node retained registry', () => {
  it('binds one exact executor to every definition in canonical order', () => {
    expect(
      CORE_NODE_EXECUTOR_REGISTRATIONS.map(({ executor }) => executor),
    ).toEqual(
      CORE_NODE_DEFINITION_REGISTRATIONS.map(
        ({ manifest }) => manifest.executor,
      ),
    );
    expect(
      new Set(
        CORE_NODE_EXECUTOR_REGISTRATIONS.map(
          ({ executor }) => `${executor.key}@${String(executor.version)}`,
        ),
      ).size,
    ).toBe(CORE_NODE_EXECUTOR_REGISTRATIONS.length);
  });

  it('recursively freezes every owned manifest tree', () => {
    for (const { manifest } of CORE_NODE_DEFINITION_REGISTRATIONS)
      expectRecursivelyFrozen(manifest);
  });

  it('publishes exactly the first three active definitions with exact executors', () => {
    expect(CORE_DEFINITION_MANIFESTS.map((item) => item.definition)).toEqual([
      { key: 'core.manual', version: 1 },
      { key: 'core.set', version: 1 },
      { key: 'core.terminate', version: 1 },
    ]);
    expect(
      CORE_DEFINITION_MANIFESTS.every((item) => item.lifecycle === 'active'),
    ).toBe(true);
    expect(CORE_DEFINITION_MANIFESTS.map((item) => item.executor)).toEqual([
      { key: 'core.manual', version: 1 },
      { key: 'core.set', version: 1 },
      { key: 'core.terminate', version: 1 },
    ]);
    expect(CORE_REGISTRY_RELEASE.epoch).toBe(1);
    expect(CORE_REGISTRY_RELEASE.policies).toContainEqual(
      CORE_BOUNDED_JSON_POLICY,
    );
    expect(Object.isFrozen(CORE_REGISTRY_RELEASE)).toBe(true);
    expect(
      CORE_DEFINITION_MANIFESTS.every(
        (manifest) => manifest.credentialRequirements.length === 0,
      ),
    ).toBe(true);
    expect(
      CORE_DEFINITION_MANIFESTS.every(
        (manifest) => manifest.connectionRequirements.length === 0,
      ),
    ).toBe(true);
  });

  it('binds the exact implementations to a lifecycle-only successor', async () => {
    const successor = createRegistryReleaseSuccessor({
      previous: CORE_REGISTRY_RELEASE,
      epoch: 2,
      definitions: CORE_REGISTRY_RELEASE.definitions.map((manifest) => ({
        ...manifest,
        lifecycle:
          manifest.definition.key === 'core.manual'
            ? ('deprecated' as const)
            : manifest.lifecycle,
      })),
      executors: CORE_REGISTRY_RELEASE.executors,
      policies: CORE_REGISTRY_RELEASE.policies,
    });
    const registry = createCoreNodeRegistryForRelease(successor);

    await expect(
      registry.execute({
        config: {},
        definition: CORE_MANUAL_DEFINITION,
        executor: CORE_MANUAL_EXECUTOR,
        input: { rollout: true },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      kind: 'succeeded',
      output: { rollout: true },
    });
    expect(registry.compatibility.fingerprint).toBe(successor.fingerprint);
    expect(() =>
      createCoreNodeRegistryForRelease(
        createRegistryReleaseSuccessor({
          previous: CORE_REGISTRY_RELEASE,
          epoch: 3,
          definitions: CORE_REGISTRY_RELEASE.definitions,
          executors: CORE_REGISTRY_RELEASE.executors,
          policies: CORE_REGISTRY_RELEASE.policies,
        }),
      ),
    ).toThrow('compatibility release epoch must be contiguous');
  });

  it('does not expose placement or publication catalogs before completion', () => {
    expect(Object.keys(createCoreNodeRegistry()).sort()).toEqual([
      'compatibility',
      'dispatchMode',
      'execute',
      'historicalCatalog',
    ]);
  });
});
