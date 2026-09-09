import { describe, expect, it } from 'vitest';

import {
  catalogClientContract,
  catalogOpenApiDocument,
  catalogQuerySchema,
  catalogReleaseSchema,
  catalogLimitsV1,
  nodeDefinitionCatalogItemSchema,
} from '../src/catalog.js';

describe('catalog discovery contracts', () => {
  it('bounds schema documents while accepting the exact property limit', () => {
    const item = {
      schemaVersion: 1,
      definition: { key: 'core.map', version: 1 },
      family: 'transform',
      configVersion: 1,
      configSchema: {},
      inputSchema: {},
      outputSchema: {},
      ports: { inputs: ['main'], outputs: ['main'] },
      credentialRequirements: [],
      connectionRequirements: [],
      retryClass: 'safe',
      resourceClass: 'cpu',
      capabilities: [],
      lifecycle: 'active',
      available: true,
      publishable: true,
    };
    const document = Object.fromEntries(
      Array.from({ length: catalogLimitsV1.schemaProperties }, (_, index) => [
        `property${String(index)}`,
        true,
      ]),
    );
    expect(
      nodeDefinitionCatalogItemSchema.safeParse({
        ...item,
        configSchema: document,
      }).success,
    ).toBe(true);
    for (const field of ['configSchema', 'inputSchema', 'outputSchema']) {
      const result = nodeDefinitionCatalogItemSchema.safeParse({
        ...item,
        [field]: { ...document, excess: true },
      });
      expect(result.success).toBe(false);
      if (!result.success)
        expect(result.error.issues).toEqual([
          expect.objectContaining({
            path: [field],
            message: 'schema document exceeds the property limit',
          }),
        ]);
    }
  });

  it('preserves the registry release identity invariant', () => {
    const release = {
      epoch: 1,
      fingerprint: `node-compat:v1:sha256:${'a'.repeat(64)}`,
    };
    expect(catalogReleaseSchema.parse(release)).toEqual(release);
    for (const invalid of [
      { ...release, epoch: 0 },
      { ...release, epoch: 1.5 },
      { ...release, fingerprint: 'bad' },
      { ...release, fingerprint: `node-compat:v1:sha256:${'g'.repeat(64)}` },
    ])
      expect(catalogReleaseSchema.safeParse(invalid).success).toBe(false);
  });

  it('documents authenticated, unfiltered reads and their failure responses', () => {
    expect(catalogQuerySchema.parse({})).toEqual({});
    expect(catalogQuerySchema.safeParse({ filter: 'arbitrary' }).success).toBe(
      false,
    );
    expect(catalogClientContract.schemas.CatalogQuery).toMatchObject({
      additionalProperties: false,
    });
    for (const path of Object.values(catalogOpenApiDocument.paths)) {
      expect(path.get.security).toEqual([{ cookieSession: [] }]);
      expect(Object.keys(path.get.responses)).toEqual([
        '200',
        '400',
        '401',
        '429',
        '500',
      ]);
    }
  });
});
