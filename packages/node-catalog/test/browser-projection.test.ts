import { describe, expect, it } from 'vitest';
import { selectOutputVariant } from '@pertexo/node-sdk';
import { isRecord } from '@pertexo/workflow-model';

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
        .sort((left, right) => {
          if (left.definition.key < right.definition.key) return -1;
          if (left.definition.key > right.definition.key) return 1;
          return left.definition.version - right.definition.version;
        })
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

  it.each([
    [{}, 'body'],
    [{ pagination: { mode: 'page' } }, 'items'],
    [{ pagination: { mode: 'page', outputMode: 'pages' } }, 'pages'],
  ] as const)(
    'lets browser clients discover %s as %s output',
    (config, field) => {
      const item = platformBrowserNodeDefinitionCatalog().definitions.find(
        (definition) => definition.definition.key === 'http.request',
      );
      if (item?.outputVariant === undefined)
        throw new Error('HTTP output discovery is missing');
      const alternatives = item.outputSchema.anyOf ?? item.outputSchema.oneOf;
      if (!Array.isArray(alternatives))
        throw new Error('HTTP output alternatives are missing');
      const selected: unknown =
        alternatives[selectOutputVariant(item.outputVariant, config)];
      if (!isRecord(selected) || !isRecord(selected.properties))
        throw new Error('Selected output fields are missing');
      const fields = Object.keys(selected.properties);
      expect(fields).toContain(field);
      for (const other of ['body', 'items', 'pages'])
        if (other !== field) expect(fields).not.toContain(other);
    },
  );

  it('advertises the logical Approval result rather than the private declaration marker', () => {
    const item = platformBrowserNodeDefinitionCatalog().definitions.find(
      (definition) => definition.definition.key === 'core.approval',
    );
    expect(item?.outputSchema).toMatchObject({
      type: 'object',
      properties: {
        decision: { enum: ['approved', 'rejected'] },
        comment: {},
        decidedBy: { type: 'string' },
        decidedAt: { type: 'string' },
      },
    });
    expect(JSON.stringify(item?.outputSchema)).not.toContain('pending');
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
