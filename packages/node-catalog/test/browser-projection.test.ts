import { describe, expect, it } from 'vitest';

import { platformBrowserNodeDefinitionCatalog } from '../src/index.js';

function expectDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child);
}

describe('browser-safe platform catalog projection', () => {
  it('returns deterministic metadata and schemas without runtime identities', () => {
    const first = platformBrowserNodeDefinitionCatalog();
    const second = platformBrowserNodeDefinitionCatalog();
    expect(first).toEqual(second);
    expect(first.definitions.length).toBeGreaterThan(0);
    expect(first.definitions.map(({ definition }) => definition)).toEqual(
      [...first.definitions]
        .sort((left, right) =>
          left.definition.key < right.definition.key
            ? -1
            : left.definition.key > right.definition.key
              ? 1
              : left.definition.version - right.definition.version,
        )
        .map(({ definition }) => definition),
    );
    for (const definition of first.definitions) {
      expect(definition).not.toHaveProperty('executor');
      expect(definition).not.toHaveProperty('executorAbi');
      expect(definition).not.toHaveProperty('policyReferences');
      expect(definition.configSchema).toBeTypeOf('object');
      expect(definition.inputSchema).toBeTypeOf('object');
      expect(definition.outputSchema).toBeTypeOf('object');
    }
  });

  it('offers every node to the browser, including integrations', () => {
    const catalog = platformBrowserNodeDefinitionCatalog();
    const keys = new Set(
      catalog.definitions.map(({ definition }) => definition.key),
    );
    for (const key of [
      'core.manual',
      'core.condition',
      'core.switch',
      'core.foreach',
      'core.wait',
      'http.request',
    ])
      expect(keys).toContain(key);
    expectDeepFrozen(catalog);
  });
});
