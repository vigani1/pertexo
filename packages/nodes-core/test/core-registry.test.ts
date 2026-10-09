import { describe, expect, it } from 'vitest';

import {
  CORE_BOUNDED_JSON_POLICY,
  CORE_DEFINITION_MANIFESTS,
  CORE_NODE_DEFINITION_REGISTRATIONS,
  CORE_NODE_CATALOG,
} from '../src/index.js';
import { CORE_NODE_EXECUTOR_REGISTRATIONS } from '../src/server.js';

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
    expect(CORE_DEFINITION_MANIFESTS.map((item) => item.executor)).toEqual([
      { key: 'core.manual', version: 1 },
      { key: 'core.set', version: 1 },
      { key: 'core.terminate', version: 1 },
    ]);
    expect(CORE_NODE_CATALOG.policies).toContainEqual(CORE_BOUNDED_JSON_POLICY);
    expect(Object.isFrozen(CORE_NODE_CATALOG)).toBe(true);
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
