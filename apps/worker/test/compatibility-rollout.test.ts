import { createRegistryReleaseSuccessor } from '@pertexo/node-sdk';
import {
  CORE_MANUAL_DEFINITION,
  CORE_MANUAL_EXECUTOR,
  CORE_REGISTRY_RELEASE,
} from '@pertexo/nodes-core';
import { createCoreNodeRegistryForRelease } from '@pertexo/nodes-core/server';
import {
  composeExecutableCompatibilityRelease,
  createExecutableCompatibilityReleaseSupport,
} from '@pertexo/workflow-engine';
import { describe, expect, it } from 'vitest';

function targetNodeRelease() {
  return createRegistryReleaseSuccessor({
    previous: CORE_REGISTRY_RELEASE,
    epoch: CORE_REGISTRY_RELEASE.epoch + 1,
    definitions: CORE_REGISTRY_RELEASE.definitions.map((manifest) => ({
      ...manifest,
      lifecycle:
        manifest.definition.key === CORE_MANUAL_DEFINITION.key
          ? ('deprecated' as const)
          : manifest.lifecycle,
    })),
    executors: CORE_REGISTRY_RELEASE.executors,
    policies: CORE_REGISTRY_RELEASE.policies,
  });
}

describe('worker rolling compatibility cohort', () => {
  it('reports and executes every exact release pair in one additive artifact', async () => {
    const target = targetNodeRelease();
    const currentExecutableRelease = composeExecutableCompatibilityRelease(
      CORE_REGISTRY_RELEASE,
    );
    const targetExecutableRelease =
      composeExecutableCompatibilityRelease(target);
    const support = createExecutableCompatibilityReleaseSupport([
      currentExecutableRelease,
      targetExecutableRelease,
    ]);
    const currentRegistry = createCoreNodeRegistryForRelease(
      CORE_REGISTRY_RELEASE,
    );
    const targetRegistry = createCoreNodeRegistryForRelease(target);

    expect(
      support.descriptions.map(({ epoch, fingerprint }) => ({
        epoch,
        fingerprint,
      })),
    ).toEqual([
      {
        epoch: currentExecutableRelease.epoch,
        fingerprint: currentExecutableRelease.fingerprint,
      },
      {
        epoch: targetExecutableRelease.epoch,
        fingerprint: targetExecutableRelease.fingerprint,
      },
    ]);
    for (const registry of [currentRegistry, targetRegistry])
      await expect(
        registry.execute({
          config: {},
          definition: CORE_MANUAL_DEFINITION,
          executor: CORE_MANUAL_EXECUTOR,
          input: { cohort: 'ready' },
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual({
        kind: 'succeeded',
        output: { cohort: 'ready' },
      });
    expect(() =>
      support.resolve(
        targetExecutableRelease.epoch,
        currentExecutableRelease.fingerprint,
      ),
    ).toThrow('not supported by this artifact');
  });
});
