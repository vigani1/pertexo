import { describe, expect, it } from 'vitest';

import {
  boundedNodeJsonSchema,
  createNodeCatalog,
  generateSchemaDocument,
  isBoundedNodeJson,
  nodeCatalogSchema,
  type NodeManifest,
} from '../../src/definitions/catalog.js';
import {
  InvalidBoundedJsonError,
  NODE_EXECUTION_LIMITS,
  canonicalizeBoundedJson,
} from '../../src/server.js';
import { policy, manifest, catalog } from '../support/registry.js';

describe('node-sdk bounded JSON contracts', () => {
  it('keeps browser and server bounded JSON admission in parity', () => {
    expect(
      generateSchemaDocument(boundedNodeJsonSchema)[
        'x-pertexo-node-json-limits'
      ],
    ).toEqual(NODE_EXECUTION_LIMITS);
    const exact = 'x'.repeat(NODE_EXECUTION_LIMITS.bytes - 2);
    const over = `${exact}x`;
    expect(boundedNodeJsonSchema.safeParse(exact).success).toBe(true);
    expect(() => canonicalizeBoundedJson(exact)).not.toThrow();
    expect(boundedNodeJsonSchema.safeParse(over).success).toBe(false);
    expect(() => canonicalizeBoundedJson(over)).toThrow(
      InvalidBoundedJsonError,
    );

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(boundedNodeJsonSchema.safeParse(cyclic).success).toBe(false);
    expect(() => canonicalizeBoundedJson(cyclic)).toThrow(
      InvalidBoundedJsonError,
    );

    const sparse = new Array<unknown>(1);
    expect(boundedNodeJsonSchema.safeParse(sparse).success).toBe(false);
    expect(() => canonicalizeBoundedJson(sparse)).toThrow(
      InvalidBoundedJsonError,
    );

    const oversizedSparse = new Array<unknown>(
      NODE_EXECUTION_LIMITS.members + 1,
    );
    expect(boundedNodeJsonSchema.safeParse(oversizedSparse).success).toBe(
      false,
    );
    expect(() => canonicalizeBoundedJson(oversizedSparse)).toThrow(
      InvalidBoundedJsonError,
    );

    const shared = { value: true };
    const repeated = [shared, shared];
    expect(boundedNodeJsonSchema.safeParse(repeated).success).toBe(false);
    expect(() => canonicalizeBoundedJson(repeated)).toThrow(
      InvalidBoundedJsonError,
    );

    const withExtraArrayProperty: unknown[] & { extra?: string } = [];
    withExtraArrayProperty.extra = 'discarded';
    expect(
      boundedNodeJsonSchema.safeParse(withExtraArrayProperty).success,
    ).toBe(false);
    expect(() => canonicalizeBoundedJson(withExtraArrayProperty)).toThrow(
      InvalidBoundedJsonError,
    );
  });

  it('keeps browser and server admission aligned for hostile root and nested values', () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 'must-not-run';
      },
    });
    const symbolBearing = { value: true };
    Object.defineProperty(symbolBearing, Symbol('secret'), {
      enumerable: true,
      value: 'must-not-leak',
    });
    const nestedAccessor = { nested: accessor };
    const nestedSymbolBearing = { nested: symbolBearing };
    const nestedArray: unknown[] & { extra?: string } = [true];
    nestedArray.extra = 'not-json';
    const invalidValues: readonly unknown[] = [
      undefined,
      1n,
      () => undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      new Date('2026-08-20T00:00:00.000Z'),
      symbolBearing,
      accessor,
      nestedAccessor,
      nestedSymbolBearing,
      { nested: undefined },
      { nested: 1n },
      { nested: () => undefined },
      { nested: Number.NEGATIVE_INFINITY },
      { nested: new Map() },
      { nested: nestedArray },
    ];

    for (const value of invalidValues) {
      expect(boundedNodeJsonSchema.safeParse(value).success).toBe(false);
      expect(() => canonicalizeBoundedJson(value)).toThrow(
        InvalidBoundedJsonError,
      );
    }
    expect(getterCalls).toBe(0);
  });

  it('measures and returns one own-data snapshot without invoking hidden JSON hooks', () => {
    let getterCalls = 0;
    let methodCalls = 0;
    const oversized = Object.defineProperty(
      { value: 'x'.repeat(NODE_EXECUTION_LIMITS.bytes) },
      'toJSON',
      {
        get: () => {
          getterCalls += 1;
          return () => {
            methodCalls += 1;
            return {};
          };
        },
      },
    );
    const nested = Object.defineProperty({ value: true }, 'toJSON', {
      value: () => {
        methodCalls += 1;
        return {};
      },
    });
    const oversizedMethod = Object.defineProperty(
      { value: 'x'.repeat(NODE_EXECUTION_LIMITS.bytes) },
      'toJSON',
      {
        value: () => {
          methodCalls += 1;
          return {};
        },
      },
    );
    const nestedGetter = Object.defineProperty({ value: true }, 'toJSON', {
      get: () => {
        getterCalls += 1;
        return () => ({});
      },
    });
    const rootMethod = Object.defineProperty({ value: true }, 'toJSON', {
      value: () => {
        methodCalls += 1;
        return {};
      },
    });

    expect(isBoundedNodeJson(oversized)).toBe(false);
    expect(isBoundedNodeJson(oversizedMethod)).toBe(false);
    expect(boundedNodeJsonSchema.safeParse(oversized).success).toBe(false);
    expect(boundedNodeJsonSchema.safeParse(oversizedMethod).success).toBe(
      false,
    );
    expect(() => canonicalizeBoundedJson(oversized)).toThrow(/byte limit/u);
    expect(() => canonicalizeBoundedJson(oversizedMethod)).toThrow(
      /byte limit/u,
    );
    for (const input of [rootMethod, { nested }, { nested: nestedGetter }]) {
      const browserSnapshot = boundedNodeJsonSchema.parse(input);
      const serverSnapshot = canonicalizeBoundedJson(input);
      expect(browserSnapshot).toEqual(serverSnapshot);
      expect(JSON.stringify(browserSnapshot)).toBe(
        JSON.stringify(serverSnapshot),
      );
      expect(Object.isFrozen(browserSnapshot)).toBe(true);
      for (const child of Object.values(
        browserSnapshot as Record<string, unknown>,
      ))
        if (child !== null && typeof child === 'object')
          expect(Object.isFrozen(child)).toBe(true);
    }
    expect(getterCalls).toBe(0);
    expect(methodCalls).toBe(0);
  });

  it('never reads proxy values after descriptor inspection', () => {
    let getCalls = 0;
    const input = new Proxy(
      { nested: { value: true } },
      {
        get: () => {
          getCalls += 1;
          throw new Error('value trap must not run');
        },
      },
    );
    const arrayInput = new Proxy([{ value: true }], {
      get: () => {
        getCalls += 1;
        throw new Error('array value trap must not run');
      },
    });
    const mutationTarget = { value: 'accepted' };
    let descriptorCalls = 0;
    const mutationInput = new Proxy(mutationTarget, {
      getOwnPropertyDescriptor: (target, key) => {
        descriptorCalls += 1;
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        if (descriptorCalls === 2) target.value = 'mutated-after-snapshot';
        return descriptor;
      },
    });

    expect(boundedNodeJsonSchema.parse(input)).toEqual({
      nested: { value: true },
    });
    expect(canonicalizeBoundedJson(input)).toEqual({
      nested: { value: true },
    });
    expect(boundedNodeJsonSchema.parse(arrayInput)).toEqual([{ value: true }]);
    expect(canonicalizeBoundedJson(arrayInput)).toEqual([{ value: true }]);
    expect(canonicalizeBoundedJson(mutationInput)).toEqual({
      value: 'accepted',
    });
    expect(mutationTarget.value).toBe('mutated-after-snapshot');
    expect(getCalls).toBe(0);
  });

  it('accepts null-prototype JSON and normalizes negative zero on the server', () => {
    const nullPrototype = Object.assign(Object.create(null) as object, {
      nested: { value: true },
    });
    expect(boundedNodeJsonSchema.safeParse(nullPrototype).success).toBe(true);
    expect(canonicalizeBoundedJson(nullPrototype)).toEqual({
      nested: { value: true },
    });
    expect(boundedNodeJsonSchema.safeParse(-0).success).toBe(true);
    const normalized = canonicalizeBoundedJson(-0);
    expect(normalized).toBe(0);
    expect(Object.is(normalized, -0)).toBe(false);
  });

  it('preserves hostile JSON property names as own data', () => {
    const input = JSON.parse(
      '{"__proto__":{"polluted":true},"nested":{"constructor":1,"prototype":2}}',
    ) as unknown;
    const canonical = canonicalizeBoundedJson(input);

    expect(JSON.stringify(canonical)).toBe(JSON.stringify(input));
    expect(Object.hasOwn(canonical as object, '__proto__')).toBe(true);
    expect((canonical as { polluted?: boolean }).polluted).toBeUndefined();

    const hostileManifest = {
      ...manifest,
      configSchema: input as NodeManifest['configSchema'],
    };
    const created = createNodeCatalog({
      definitions: [hostileManifest],
      executors: catalog().executors,
      policies: [policy],
    });
    expect(nodeCatalogSchema.parse(created)).toEqual(created);
    expect(JSON.stringify(created.definitions[0]?.configSchema)).toBe(
      JSON.stringify(input),
    );
  });
});
