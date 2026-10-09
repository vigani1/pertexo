import { describe, expect, it } from 'vitest';

import {
  CORE_BOUNDED_JSON_POLICY,
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

describe('core node catalog', () => {
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

  it('catalogs every core definition with its own executor', () => {
    expect(CORE_NODE_CATALOG.definitions).toHaveLength(
      CORE_NODE_DEFINITION_REGISTRATIONS.length,
    );
    expect(CORE_NODE_CATALOG.executors.map(({ executor }) => executor)).toEqual(
      CORE_NODE_CATALOG.definitions.map(({ executor }) => executor),
    );
    expect(CORE_NODE_CATALOG.policies).toContainEqual(CORE_BOUNDED_JSON_POLICY);
    expect(Object.isFrozen(CORE_NODE_CATALOG)).toBe(true);
    expect(
      CORE_NODE_CATALOG.definitions.every(
        (manifest) =>
          manifest.credentialRequirements.length === 0 &&
          manifest.connectionRequirements.length === 0,
      ),
    ).toBe(true);
  });
});
