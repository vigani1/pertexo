import { describe, expect, it } from 'vitest';

import {
  platformBrowserNodeDefinitionCatalog,
  platformServingRegistryRelease,
} from '../src/index.js';

describe('browser-safe platform catalog projection', () => {
  it('returns deterministic metadata and schemas without runtime identities', () => {
    const first = platformBrowserNodeDefinitionCatalog('core');
    const second = platformBrowserNodeDefinitionCatalog('core');
    expect(first).toEqual(second);
    expect(first.release).toEqual({
      epoch: platformServingRegistryRelease('core').epoch,
      fingerprint: platformServingRegistryRelease('core').fingerprint,
    });
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
      expect(definition.publishable).toBe(true);
      expect(definition.available).toBe(definition.lifecycle === 'active');
    }
  });

  it('uses the serving release for each cohort and never admits staged additions', () => {
    const staging = platformBrowserNodeDefinitionCatalog('http_staging');
    const activation = platformBrowserNodeDefinitionCatalog('http_activation');
    expect(
      staging.definitions.some(
        ({ definition }) => definition.key === 'http.request',
      ),
    ).toBe(false);
    expect(
      activation.definitions.some(
        ({ definition }) => definition.key === 'http.request',
      ),
    ).toBe(true);
    expect(staging.release).toEqual({
      epoch: platformServingRegistryRelease('http_staging').epoch,
      fingerprint: platformServingRegistryRelease('http_staging').fingerprint,
    });
  });
});
