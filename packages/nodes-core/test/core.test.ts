import { describe, expect, it } from 'vitest';
import { createRegistryReleaseSuccessor } from '@pertexo/node-sdk';

import {
  CORE_BOUNDED_JSON_POLICY,
  CORE_DEFINITION_MANIFESTS,
  CORE_MANUAL_DEFINITION,
  CORE_MANUAL_EXECUTOR,
  CORE_REGISTRY_RELEASE,
  CORE_SET_DEFINITION,
  CORE_SET_EXECUTOR,
  CORE_SET_INPUT_SCHEMA,
  CORE_TERMINATE_DEFINITION,
  CORE_TERMINATE_EXECUTOR,
} from '../src/index.js';
import {
  createCoreNodeRegistry,
  createCoreNodeRegistryForRelease,
} from '../src/server.js';

const signal = new AbortController().signal;

describe('core node release', () => {
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
});

describe('core node execution', () => {
  it('binds the exact core implementations to a lifecycle-only successor', async () => {
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
        signal,
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
    ).toThrow('next successor');
  });

  it('does not expose placement or publication catalogs before vertical-slice completion', () => {
    expect(Object.keys(createCoreNodeRegistry()).sort()).toEqual([
      'compatibility',
      'dispatchMode',
      'execute',
      'historicalCatalog',
    ]);
  });

  it('passes Manual input through canonically without mutation', async () => {
    const registry = createCoreNodeRegistry();
    const input = { b: 2, a: [true, null] };
    const result = await registry.execute({
      config: {},
      definition: CORE_MANUAL_DEFINITION,
      executor: CORE_MANUAL_EXECUTOR,
      input,
      signal,
    });

    expect(result).toEqual({
      kind: 'succeeded',
      output: { a: [true, null], b: 2 },
    });
    expect(input).toEqual({ b: 2, a: [true, null] });
  });

  it('passes an already-resolved Set/Map record through canonically', async () => {
    const registry = createCoreNodeRegistry();
    const result = await registry.execute({
      config: {},
      definition: CORE_SET_DEFINITION,
      executor: CORE_SET_EXECUTOR,
      input: { z: 42, a: 'resolved' },
      signal,
    });

    expect(result).toEqual({
      kind: 'succeeded',
      output: { a: 'resolved', z: 42 },
    });
  });

  it('accepts explicit null values and rejects non-record Set input', async () => {
    const registry = createCoreNodeRegistry();
    await expect(
      registry.execute({
        config: {},
        definition: CORE_SET_DEFINITION,
        executor: CORE_SET_EXECUTOR,
        input: [],
        signal,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      registry.execute({
        config: {},
        definition: CORE_SET_DEFINITION,
        executor: CORE_SET_EXECUTOR,
        input: { explicit: null },
        signal,
      }),
    ).resolves.toEqual({ kind: 'succeeded', output: { explicit: null } });
  });

  it('returns an explicit terminal-success result from Terminate', async () => {
    const registry = createCoreNodeRegistry();
    await expect(
      registry.execute({
        config: {},
        definition: CORE_TERMINATE_DEFINITION,
        executor: CORE_TERMINATE_EXECUTOR,
        input: { done: true },
        signal,
      }),
    ).resolves.toEqual({
      kind: 'terminal_success',
      output: { done: true },
    });
  });

  it('fails before invoking an executor when already aborted', async () => {
    const registry = createCoreNodeRegistry();
    const controller = new AbortController();
    controller.abort();
    await expect(
      registry.execute({
        config: {},
        definition: CORE_MANUAL_DEFINITION,
        executor: CORE_MANUAL_EXECUTOR,
        input: { value: 1 },
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'aborted' });
  });

  it('keeps configuration strict and browser input bounds match execution', async () => {
    const registry = createCoreNodeRegistry();
    await expect(
      registry.execute({
        config: { unsupported: true },
        definition: CORE_MANUAL_DEFINITION,
        executor: CORE_MANUAL_EXECUTOR,
        input: { value: 1 },
        signal,
      }),
    ).rejects.toMatchObject({ code: 'invalid_config' });
    const over = { value: 'x'.repeat(1_048_576) };
    expect(CORE_SET_INPUT_SCHEMA.safeParse(over).success).toBe(false);
    await expect(
      registry.execute({
        config: {},
        definition: CORE_SET_DEFINITION,
        executor: CORE_SET_EXECUTOR,
        input: over,
        signal,
      }),
    ).rejects.toMatchObject({ code: 'invalid_json' });
  });

  it('executes the golden contract for every initial definition/executor pair', async () => {
    const registry = createCoreNodeRegistry();
    const fixtures = [
      {
        definition: CORE_MANUAL_DEFINITION,
        executor: CORE_MANUAL_EXECUTOR,
        input: { value: 'manual' },
        expected: { kind: 'succeeded', output: { value: 'manual' } },
      },
      {
        definition: CORE_SET_DEFINITION,
        executor: CORE_SET_EXECUTOR,
        input: { value: 'set' },
        expected: { kind: 'succeeded', output: { value: 'set' } },
      },
      {
        definition: CORE_TERMINATE_DEFINITION,
        executor: CORE_TERMINATE_EXECUTOR,
        input: { value: 'terminate' },
        expected: { kind: 'terminal_success', output: { value: 'terminate' } },
      },
    ] as const;
    for (const fixture of fixtures)
      await expect(
        registry.execute({ ...fixture, config: {}, signal }),
      ).resolves.toEqual(fixture.expected);
  });
});
