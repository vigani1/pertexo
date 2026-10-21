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

  it('lists every core node, one version each', () => {
    expect(
      CORE_NODE_DEFINITION_REGISTRATIONS.map(
        ({ manifest }) =>
          `${manifest.definition.key}@${String(manifest.definition.version)}`,
      ),
    ).toEqual([
      'core.run_values@1',
      'core.create_file@1',
      'core.table_find@1',
      'core.table_insert@1',
      'core.table_update@1',
      'core.table_upsert@1',
      'core.table_delete@1',
      'core.text@1',
      'core.number@1',
      'core.crypto@1',
      'core.hmac@1',
      'core.xml@1',
      'core.html@1',
      'core.code@1',
      'core.respond_webhook@1',
      'core.request_input@1',
      'core.form@1',
      'core.approval@1',
      'core.workflow_error@1',
      'core.read_file@1',
      'core.concat@1',
      'core.take@1',
      'core.batch@1',
      'core.filter@1',
      'core.sort@1',
      'core.unique@1',
      'core.summarize@1',
      'core.date@1',
      'core.call@1',
      'core.schedule@1',
      'core.webhook@1',
      'core.wait@1',
      'core.foreach@1',
      'core.merge@1',
      'core.parallel@1',
      'core.switch@1',
      'core.condition@1',
      'core.manual@1',
      'core.set@1',
      'core.terminate@1',
      'core.validate@1',
    ]);
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
          (manifest.definition.key === 'core.hmac'
            ? manifest.connectionRequirements.join(',') === 'hmac_key'
            : manifest.connectionRequirements.length === 0),
      ),
    ).toBe(true);
  });
});
