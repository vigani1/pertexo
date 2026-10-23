import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  createNodeCatalog,
  generateSchemaDocument,
  nodeManifestSchema,
  parseNodeCatalog,
  nodeCatalogSchema,
} from '../../src/definitions/catalog.js';
import { NodeExecutorFailure, createNodeRegistry } from '../../src/server.js';
import {
  definition,
  executor,
  policy,
  secondPolicy,
  manifest,
  executorRegistration,
  configSchema,
  objectSchema,
  catalog,
} from '../support/registry.js';

describe('node-sdk catalog contracts', () => {
  it('rejects a catalog definition or executor that is not implemented', () => {
    const selected = catalog();
    const registration = {
      manifest,
      configSchema,
      inputSchema: objectSchema,
      outputSchema: objectSchema,
    };
    expect(() =>
      createNodeRegistry({
        catalog: selected,
        definitions: [],
        executors: [executorRegistration()],
      }),
    ).toThrow(
      /catalog definition test.echo@1 has no server schema registration/u,
    );
    expect(() =>
      createNodeRegistry({
        catalog: selected,
        definitions: [registration],
        executors: [],
      }),
    ).toThrow(/catalog executor test.echo@1 has no implementation/u);
  });

  it('rejects malformed and unbounded executor failure kinds', () => {
    expect(
      () =>
        new NodeExecutorFailure({
          kind: 'failed',
          errorKind: 'x'.repeat(65),
          possiblyDispatched: false,
        }),
    ).toThrow(new TypeError('Invalid node executor failure'));
    expect(
      () =>
        new NodeExecutorFailure({
          kind: 'failed',
          errorKind: 'Provider Secret',
          possiblyDispatched: false,
        }),
    ).toThrow(new TypeError('Invalid node executor failure'));
  });

  it.each([-1, 60_001, 0.5, '3000'])(
    'rejects an invalid minimum retry delay %s',
    (minimumRetryDelayMillis) => {
      expect(
        () =>
          new NodeExecutorFailure({
            kind: 'retry',
            errorKind: 'rate_limit',
            possiblyDispatched: false,
            minimumRetryDelayMillis,
          }),
      ).toThrow('Invalid node executor failure');
    },
  );

  it('sorts definitions, executors and policies regardless of declaration order', () => {
    const one = catalog();
    const reversed = createNodeCatalog({
      definitions: [...one.definitions].reverse(),
      executors: [...one.executors].reverse(),
      policies: [...one.policies].reverse(),
    });
    expect(reversed).toEqual(one);
    expect(nodeCatalogSchema.parse(one)).toEqual(one);
  });

  it('rejects duplicate definition policies before set comparison', () => {
    const malformedInput = {
      definitions: [{ ...manifest, policyReferences: [policy, policy] }],
      executors: [
        {
          abiVersion: 1,
          definitions: [definition],
          executor,
          policyReferences: [policy, secondPolicy],
        },
      ],
      policies: [policy, secondPolicy],
    };

    expect(() => createNodeCatalog(malformedInput)).toThrow(
      /duplicate definition policy/u,
    );
    expect(() => parseNodeCatalog(malformedInput)).toThrow(
      /duplicate definition policy/u,
    );
    expect(() =>
      createNodeCatalog({
        ...malformedInput,
        executors: [
          {
            abiVersion: 1,
            definitions: [definition],
            executor,
            policyReferences: [policy, policy],
          },
        ],
      }),
    ).toThrow(/duplicate definition policy/u);
  });

  it('accepts unique reordered policies and rejects unknown or version-drifted edges', () => {
    const reordered = createNodeCatalog({
      definitions: [{ ...manifest, policyReferences: [secondPolicy, policy] }],
      executors: [
        {
          abiVersion: 1,
          definitions: [definition],
          executor,
          policyReferences: [policy, secondPolicy],
        },
      ],
      policies: [secondPolicy, policy],
    });
    const oppositeOrder = createNodeCatalog({
      definitions: [{ ...manifest, policyReferences: [policy, secondPolicy] }],
      executors: [
        {
          abiVersion: 1,
          definitions: [definition],
          executor,
          policyReferences: [secondPolicy, policy],
        },
      ],
      policies: [policy, secondPolicy],
    });

    expect(reordered.definitions).toHaveLength(1);
    expect(oppositeOrder.definitions).toHaveLength(1);
    expect(() =>
      createNodeCatalog({
        definitions: [
          {
            ...manifest,
            policyReferences: [{ ...policy, version: policy.version + 1 }],
          },
        ],
        executors: catalog().executors,
        policies: [policy],
      }),
    ).toThrow(/policies do not match/u);
    expect(() =>
      createNodeCatalog({
        definitions: [{ ...manifest, policyReferences: [secondPolicy] }],
        executors: [
          {
            abiVersion: 1,
            definitions: [definition],
            executor,
            policyReferences: [secondPolicy],
          },
        ],
        policies: [policy],
      }),
    ).toThrow(/unknown policy/u);
  });

  it('rejects a definition bound to an unknown executor', () => {
    const one = catalog();
    expect(() =>
      createNodeCatalog({
        definitions: [
          { ...manifest, executor: { key: 'test.other', version: 1 } },
        ],
        executors: one.executors,
        policies: one.policies,
      }),
    ).toThrow(/unknown executor/u);
  });

  it('validates configuration-selected output branches at catalog registration', () => {
    const outputSchema = {
      anyOf: [
        { type: 'object', properties: { body: {} } },
        { type: 'object', properties: { items: {} } },
      ],
    };
    const outputVariant = {
      configProperty: 'collect',
      whenPresent: 1,
      whenAbsent: 0,
    };
    expect(
      nodeManifestSchema.safeParse({ ...manifest, outputSchema, outputVariant })
        .success,
    ).toBe(true);
    for (const selection of [
      { ...outputVariant, whenPresent: 2 },
      { ...outputVariant, whenAbsent: -1 },
      { ...outputVariant, configProperty: '' },
    ])
      expect(
        nodeManifestSchema.safeParse({
          ...manifest,
          outputSchema,
          outputVariant: selection,
        }).success,
      ).toBe(false);
    expect(
      nodeManifestSchema.safeParse({
        ...manifest,
        outputSchema: { type: 'object' },
        outputVariant,
      }).success,
    ).toBe(false);
  });

  it('validates integration operation metadata', () => {
    const integrated = createNodeCatalog({
      definitions: [
        {
          ...manifest,
          connectionRequirements: ['primary'],
          integration: { providerKey: 'http', operationKey: 'request' },
        },
      ],
      executors: catalog().executors,
      policies: catalog().policies,
    });
    expect(nodeCatalogSchema.parse(integrated)).toEqual(integrated);
    expect(
      nodeManifestSchema.safeParse({
        ...manifest,
        integration: { providerKey: 'HTTP', operationKey: 'request' },
      }).success,
    ).toBe(false);
  });

  it('rejects recursively deep schema documents', () => {
    let deepSchema: Record<string, unknown> = {};
    for (let depth = 0; depth < 65; depth += 1)
      deepSchema = { nested: deepSchema };
    expect(
      nodeManifestSchema.safeParse({ ...manifest, configSchema: deepSchema })
        .success,
    ).toBe(false);
  });

  it('labels runtime-only schema semantics without claiming JSON Schema parity', () => {
    const refined = z.string().refine((value) => value !== 'denied');
    const projection = generateSchemaDocument(refined, {
      runtimeOnlySemantics: ['value must not equal denied'],
    });

    expect(refined.safeParse('denied').success).toBe(false);
    expect(projection).toMatchObject({
      type: 'string',
      'x-pertexo-runtime-only-semantics': ['value must not equal denied'],
    });
    expect(Object.isFrozen(projection)).toBe(true);
    expect(() =>
      generateSchemaDocument(refined, { runtimeOnlySemantics: [] as never }),
    ).toThrow();
  });
});
